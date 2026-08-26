/**
 * Tests for scripts/research-browser.mjs — the persistent-profile browser harness.
 *
 * Run: pnpm test   (node:test via tsx, no test framework dependency)
 *
 * A REAL BROWSER IS NEVER A PRECONDITION OF THIS SUITE, and neither is an X display, a VNC
 * stack, or the forge-control API. That is enforced structurally, not by discipline:
 *
 *  - The pure decision logic (argv parsing, label/run-id sanitisation, screenshot paths, the
 *    login-wall evaluator, the reminder dedup window, display allocation arithmetic) is
 *    imported directly from the .mjs. The script only runs its main() behind an isMain()
 *    inode check, so importing it launches nothing.
 *  - The CLI contract (--help, the exit codes for usage errors) is exercised by spawning the
 *    real script the way gemini-qa-cli.test.ts does. Every spawned case here fails BEFORE the
 *    script would touch playwright, Chrome, Xvfb or the network — which is itself part of the
 *    contract: a usage error must cost nothing.
 *
 * The specifier is built at runtime so TypeScript treats the import as dynamic (there is no
 * .d.ts for a zero-dependency .mjs, and adding allowJs for one file is worse than this).
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The CONSUMER's idea of where the per-profile marker lives. Imported from
// browser-takeover.ts on purpose: this file's job here is to pin a contract
// between two modules that never import each other, and a restated literal
// would agree with itself while the two sides drifted apart.
import { PROFILE_MARKER_DIR } from "./browser-takeover.ts";
import { readActivity } from "./takeover-session.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;
const SCRIPT = `${REPO_ROOT}scripts/research-browser.mjs`;
const SCRIPT_URL = new URL("../../../scripts/research-browser.mjs", import.meta.url).href;

/* -------------------------------------------------------------------------- *
 * The shape of what the script exports for testing
 * -------------------------------------------------------------------------- */

interface Signals {
  finalUrl?: string;
  passwordFieldCount?: number;
  loggedOutHits?: string[];
  loggedInHits?: string[];
}

interface Verdict {
  needsLogin: boolean;
  authenticated: boolean | null;
  reasons: string[];
  decision: string;
}

interface Service {
  key?: string;
  title: string;
  home: string | null;
  hosts: RegExp[];
  loginUrlPatterns: RegExp[];
  loggedOutSelectors: string[];
  loggedInSelectors: string[];
}

interface ParsedArgs {
  subcommand: string | null;
  profile: string | null;
  url: string | null;
  label: string | null;
  runId: string | null;
  service: string | null;
  probe: boolean;
  reminder: boolean;
  throwaway: boolean;
  help: boolean;
}

interface ProfileChoice {
  profile: string;
  refusal: string | null;
  throwaway: boolean;
  create: boolean;
}

interface TakeoverActivity {
  connected?: unknown;
  connects?: number;
  first_connect_at?: unknown;
  last_connect_at?: string | null;
  last_disconnect_at?: unknown;
  written_at?: string;
}

interface TakeoverClock {
  idleDeadline: number;
  takeoverDeadline: number | null;
  takeoverStartedAt: number | null;
  connected: number;
  shutdownReason: string | null;
  warnings: string[];
}

interface ScreenshotRecord {
  label: string;
  path: string;
  url: string;
  url_servable: boolean;
}

interface Reminder {
  id?: string;
  text?: string;
  status?: string;
  created_at?: string;
}

interface DedupResult {
  match: Reminder | null;
  ageMs: number | null;
  skipped: { id: string | null; reason: string }[];
}

/** One line of a teardown report: a process action or a port verification. */
interface TeardownAction {
  what: string;
  result: string;
  pid?: number | null;
  port?: number;
  detail?: string;
  exited_after_ms?: number;
  after_ms?: number;
}

/** The shape of .state/<profile>/takeover.json, as teardownStack() reads it. */
interface TakeoverStateRecord {
  displayNum: number;
  vncPort: number;
  novncPort: number;
  xvfb: { pid: number } | null;
  wm: { pid: number; bin: string } | null;
  autocutsel_clipboard: { pid: number } | null;
  autocutsel_primary: { pid: number } | null;
  x11vnc: { pid: number } | null;
  websockify: { pid: number } | null;
}

interface ResearchBrowser {
  EXIT: Record<string, number>;
  CliError: new (code: number, message: string) => Error & { code: number };
  PROFILE_RE: RegExp;
  SERVICES: Record<string, Service>;
  PROFILES_ROOT: string;
  STATE_ROOT: string;
  UPLOADS_ROOT: string;
  ADHOC_RUN_ID: string;
  SERVABLE_RUN_ID_RE: RegExp;
  DISPLAY_BASE: number;
  DISPLAY_SPAN: number;
  VNC_PORT_BASE: number;
  NOVNC_PORT_BASE: number;
  REMINDER_TEXT_MAX: number;
  REMINDER_DEDUP_WINDOW_MS: number;
  SUBCOMMANDS: string[];
  USAGE: string;
  fnv1a32(text: string): number;
  displaySlot(profile: string): number;
  portsForDisplay(n: number): {
    display: string;
    displayNum: number;
    vncPort: number;
    novncPort: number;
  };
  novncUrl(port: number): string;
  sshTunnelCommand(port: number, target?: string): string;
  OS_BASE_URL: string;
  takeoverUrl(runId: string, base?: string): string;
  browserStatePath(runId: string): string;
  profileMarkerPath(runId: string, profile: string): string;
  writeBrowserStateMarker(input: {
    runId: string;
    profile: string;
    service: string;
    novncPort: number;
  }): { written: boolean; reason?: string; path?: string; profile_marker_path?: string };
  sanitiseLabel(label: unknown): string;
  sanitiseRunId(runId: unknown): string | null;
  isServableRunId(runId: string): boolean;
  compactStamp(date: Date): string;
  screenshotName(date: Date, label: string): string;
  screenshotPath(runId: string, name: string): string;
  uploadsUrl(runId: string, name: string): string;
  resolveRunId(
    flag: string | null,
    env?: Record<string, string | undefined>,
  ): { runId: string; source: string };
  screenshotRecord(runId: string, date: Date, label: string): ScreenshotRecord;
  profileDir(profile: string): string;
  stateDir(profile: string): string;
  resolveService(input: { service?: string | null; url?: string | null; profile?: string | null }): Service & {
    key: string;
  };
  evaluateLoginWall(service: Partial<Service>, signals: Signals): Verdict;
  parseArgs(argv: string[]): ParsedArgs;
  resolveTargetUrl(opts: { url: string | null; profile: string }, service: Service & { key: string }): string;
  reminderMarker(profile: string, service: string): string;
  buildLoginReminderText(input: {
    profile: string;
    service: string;
    serviceTitle: string;
    runId: string;
    osBaseUrl?: string;
  }): string;
  parsePgTimestamp(value: unknown): number | null;
  findRecentLoginReminder(
    reminders: Reminder[] | undefined,
    opts: { profile: string; service: string; nowMs: number; windowMs: number },
  ): DedupResult;
  selectStaleLoginReminders(
    reminders: Reminder[] | undefined,
    opts: {
      profile: string;
      service: string;
      nowMs: number;
      windowMs: number;
      exceptId?: string | null;
    },
  ): string[];
  LOCK_PID_GRACE_MS: number;
  STARTUP_TIMEOUT_MS: number;
  classifyStartLock(input: {
    pid: number | null;
    dirAgeMs: number;
    holderAlive: boolean;
    graceMs?: number;
  }): { stale: boolean; reason: string };
  classifyTakeoverOwner(input: {
    supervisorPid: number | null | undefined;
    ownerAlive: boolean;
    anyProcessLive: boolean;
  }): { reap: boolean; stateOnly?: boolean; reason: string };
  // aios-takeover-usable R8: teardown that waits, escalates and verifies the port
  TERMINATE_GRACE_MS: number;
  KILL_GRACE_MS: number;
  PORT_RELEASE_TIMEOUT_MS: number;
  terminateAndVerify(
    pid: number,
    token: string,
    what: string,
    opts?: { graceMs?: number; killGraceMs?: number },
  ): Promise<TeardownAction>;
  verifyPortReleased(port: number, what: string, opts?: { timeoutMs?: number }): Promise<TeardownAction>;
  teardownIsComplete(actions: TeardownAction[]): boolean;
  teardownStack(
    state: TakeoverStateRecord,
    opts?: { graceMs?: number; killGraceMs?: number; portTimeoutMs?: number },
  ): Promise<{ actions: TeardownAction[]; complete: boolean }>;
  teardownTakeoverAt(
    path: string,
    opts?: { graceMs?: number; killGraceMs?: number; portTimeoutMs?: number },
  ): Promise<{ actions: TeardownAction[]; complete: boolean; origin: OriginReset }>;
  resetTakeoverOriginAt(activityPath: string, nowMs: number): OriginReset;
  PLAYWRIGHT_CANDIDATE_PATHS: string[];
  CHROME_CANDIDATE_PATHS: string[];
  WM_CANDIDATE_PATHS: string[];
  findWindowManager(paths?: string[], exists?: (p: string) => boolean): string | null;
  // aios-takeover-usable B3: one durable profile, throwaways on request
  DEFAULT_PROFILE: string;
  DEFAULT_PROFILE_ENV: string;
  throwawayMarkerPath(profile: string): string;
  resolveProfileChoice(input: {
    requested: string | null;
    exists: boolean;
    marked?: boolean;
    defaultProfile: string;
    serviceKeys: string[];
    throwaway: boolean;
  }): ProfileChoice;
  // aios-takeover-usable B3: supervisor-owned takeover clocks
  IDLE_TIMEOUT_MS: number;
  HARD_MAX_SESSION_MS: number;
  TAKEOVER_IDLE_GRACE_ENV: string;
  TAKEOVER_MAX_SESSION_ENV: string;
  TAKEOVER_IDLE_GRACE_DEFAULT_MS: number;
  TAKEOVER_MAX_SESSION_DEFAULT_MS: number;
  TAKEOVER_IDLE_GRACE_MS: number;
  TAKEOVER_MAX_SESSION_MS: number;
  takeoverActivityPath(profile: string): string;
  lastShutdownPath(profile: string): string;
  parseTakeoverClockEnv(env?: Record<string, string | undefined>): {
    idleGraceMs: number;
    takeoverMaxMs: number;
  };
  computeTakeoverDeadlines(input: {
    now: number;
    /** Fix cycle 2: the supervisor's own start (epoch ms) — the cap origin can never precede it. */
    startedAt?: number;
    activity: TakeoverActivity | unknown[] | string | null;
    idleDeadline: number;
    hardDeadline: number;
    config: { idleGraceMs: number; takeoverMaxMs: number };
  }): TakeoverClock;
}

/** What resetTakeoverOriginAt() / teardownTakeoverAt().origin report about takeover-activity.json. */
interface OriginReset {
  result: "reset" | "already-null" | "absent" | "unreadable" | "not-an-object" | "write-failed" | "kept-stack-incomplete";
  detail?: string;
}

const rb = (await import(SCRIPT_URL)) as ResearchBrowser;

/** The uploads route's own gate, copied here so the test asserts against the real constraint
 *  rather than against the script's opinion of it (forge-control/src/routes/uploads.ts). */
const UPLOADS_ROUTE_ID_RE = /^[a-f0-9]{12}$/;

function run(
  args: string[],
  envExtra: Record<string, string | undefined> = {},
): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    // A usage error must never reach the network or a browser. Poisoning both resolution
    // paths proves the failure happens before either is consulted.
    env: {
      ...process.env,
      PLAYWRIGHT_MODULE: "/nonexistent/playwright",
      RESEARCH_BROWSER_CHROME: "/nonexistent/chrome",
      ...envExtra,
    },
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

/** A name no box has: every spawned usage-error case below must leave NO trace of it. */
const UNKNOWN_PROFILE = "rbtest-unknown-zz";
const noTraceOf = (profile: string) =>
  !existsSync(rb.profileDir(profile)) && !existsSync(rb.stateDir(profile));

/* ========================================================================== *
 * CLI contract: --help and the exit-code discipline
 * ========================================================================== */

describe("CLI contract", () => {
  test("--help prints usage on stdout and exits 0", () => {
    for (const flag of ["--help", "-h"]) {
      const r = run([flag]);
      assert.equal(r.status, rb.EXIT.OK, r.stderr);
      assert.match(r.stdout, /^usage: research-browser\.mjs/);
      assert.equal(r.stderr, "");
    }
  });

  test("--help documents every subcommand and every exit code", () => {
    const { stdout } = run(["--help"]);
    for (const sub of rb.SUBCOMMANDS) {
      // [profile] in brackets: optional for every subcommand since aios-takeover-usable.
      assert.match(stdout, new RegExp(`^  ${sub} \\[profile\\]`, "m"), `${sub} missing from --help`);
    }
    for (const code of [0, 1, 2, 3, 4]) {
      assert.match(stdout, new RegExp(`^  ${code}  `, "m"), `exit ${code} missing from --help`);
    }
    assert.match(stdout, /NO PASSWORD IS EVER STORED/);
    assert.match(stdout, /127\.0\.0\.1 only|never (be )?expos/i);
    // The durable default, the disposable flag, both clocks, and the agent's end signal are
    // all part of the documented surface now.
    assert.match(stdout, new RegExp(`defaults to "${rb.DEFAULT_PROFILE}"`));
    assert.match(stdout, /--throwaway/);
    assert.match(stdout, new RegExp(`${rb.TAKEOVER_IDLE_GRACE_ENV}=${rb.TAKEOVER_IDLE_GRACE_DEFAULT_MS}`));
    assert.match(stdout, new RegExp(`${rb.TAKEOVER_MAX_SESSION_ENV}=${rb.TAKEOVER_MAX_SESSION_DEFAULT_MS}`));
    assert.match(stdout, /THIS IS THE\s+AGENT'S END SIGNAL/);
  });

  test("--help wins over anything else on the line, including a bad subcommand", () => {
    const r = run(["definitely-not-a-subcommand", "--help"]);
    assert.equal(r.status, rb.EXIT.OK);
    assert.match(r.stdout, /^usage:/);
  });

  test("no arguments is a usage error (exit 3) with the usage text on stderr", () => {
    const r = run([]);
    assert.equal(r.status, rb.EXIT.USAGE);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /missing subcommand/);
    assert.match(r.stderr, /usage: research-browser\.mjs/);
  });

  test("an unknown subcommand names the valid ones", () => {
    const r = run(["frobnicate", "perplexity"]);
    assert.equal(r.status, rb.EXIT.USAGE);
    assert.match(r.stderr, /unknown subcommand "frobnicate"/);
    assert.match(r.stderr, new RegExp(rb.SUBCOMMANDS.join(" ")));
  });

  test("an omitted <profile> is the durable default, for every subcommand — no longer an error", () => {
    // In-process: parseArgs leaves profile null and main() resolves it against the disk.
    // (Not spawned: `status` on the default would create its state dir on this box.)
    for (const sub of rb.SUBCOMMANDS) {
      assert.equal(rb.parseArgs([sub]).profile, null, `${sub} must accept no profile`);
    }
    assert.equal(rb.DEFAULT_PROFILE, "konrad-main", "the shipped default; env overrides it");
  });

  test("a NEW profile name without --throwaway is refused (exit 3) and leaves no trace", () => {
    for (const sub of rb.SUBCOMMANDS) {
      const r = run([sub, UNKNOWN_PROFILE]);
      assert.equal(r.status, rb.EXIT.USAGE, `${sub}: ${r.stderr}`);
      assert.match(r.stderr, new RegExp(`profile "${UNKNOWN_PROFILE}" does not exist`));
      assert.match(r.stderr, /pass --throwaway to create a disposable one/);
      assert.match(r.stderr, new RegExp(`omit the profile to use ${rb.DEFAULT_PROFILE}`));
      assert.equal(r.stdout, "");
    }
    assert.ok(noTraceOf(UNKNOWN_PROFILE), "a refused name must not get a profile or state dir");
  });

  test("--throwaway on the durable default is refused — it can never become disposable", () => {
    const r = run(["status", "--throwaway"]);
    assert.equal(r.status, rb.EXIT.USAGE, r.stderr);
    assert.match(r.stderr, new RegExp(`"${rb.DEFAULT_PROFILE}" is the durable default and cannot be a throwaway`));
    const explicit = run(["open", rb.DEFAULT_PROFILE, "--throwaway", "--url", "https://example.com"]);
    assert.equal(explicit.status, rb.EXIT.USAGE, explicit.stderr);
  });

  test("an invalid $RESEARCH_BROWSER_DEFAULT_PROFILE dies by name before any disk work", () => {
    const r = run(["status"], { [rb.DEFAULT_PROFILE_ENV]: "Not A Name" });
    assert.equal(r.status, rb.EXIT.USAGE, r.stderr);
    assert.match(r.stderr, new RegExp(`\\$${rb.DEFAULT_PROFILE_ENV}="Not A Name" is not a valid profile name`));
    assert.ok(noTraceOf("Not A Name"));
  });

  test("a valid $RESEARCH_BROWSER_DEFAULT_PROFILE override is what an omitted profile resolves to", () => {
    // Observed through the refusal text, which names the default — no state is created.
    const r = run(["status", UNKNOWN_PROFILE], { [rb.DEFAULT_PROFILE_ENV]: "team-shared" });
    assert.equal(r.status, rb.EXIT.USAGE, r.stderr);
    assert.match(r.stderr, /omit the profile to use team-shared/);
    assert.ok(noTraceOf("team-shared"));
  });

  test("an unreadable takeover clock kills the supervisor at start, by variable name, touching nothing", () => {
    // The internal __supervise entry is the supervisor's main(); the env check is its first
    // statement, so a bad clock exits 3 before a state dir, an X display or Chrome exists.
    for (const [name, value] of [
      [rb.TAKEOVER_MAX_SESSION_ENV, "abc"],
      [rb.TAKEOVER_IDLE_GRACE_ENV, "0"],
      [rb.TAKEOVER_IDLE_GRACE_ENV, "-5"],
      [rb.TAKEOVER_MAX_SESSION_ENV, "Infinity"],
      [rb.TAKEOVER_MAX_SESSION_ENV, ""],
    ] as const) {
      const r = run(["__supervise", UNKNOWN_PROFILE, "--display-num", "95"], { [name]: value });
      assert.equal(r.status, rb.EXIT.USAGE, `${name}=${JSON.stringify(value)}: ${r.stderr}`);
      assert.match(r.stderr, new RegExp(`${name} must be a positive finite number`));
      assert.match(r.stderr, new RegExp(JSON.stringify(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
    assert.ok(noTraceOf(UNKNOWN_PROFILE));
  });

  test("an invalid profile name is rejected before any browser or filesystem work", () => {
    for (const bad of ["../escape", "Perplexity", "has space", "a".repeat(40), ".state"]) {
      const r = run(["status", bad]);
      assert.equal(r.status, rb.EXIT.USAGE, `${bad} should be rejected: ${r.stderr}`);
      assert.match(r.stderr, /invalid profile name/);
    }
  });

  test("an unknown flag is a usage error, and a value-flag with no value too", () => {
    assert.equal(run(["status", "p", "--wat"]).status, rb.EXIT.USAGE);
    assert.match(run(["status", "p", "--wat"]).stderr, /unknown flag: --wat/);
    assert.match(run(["open", "p", "--url"]).stderr, /flag --url requires a value/);
    assert.match(run(["open", "p", "--url="]).stderr, /flag --url requires a non-empty value/);
    // A leading dash is a FLAG, per every CLI convention — it is never read as a profile name,
    // which is also what stops "-rf" style arguments from reaching a path.
    assert.equal(run(["status", "-leading"]).status, rb.EXIT.USAGE);
    assert.match(run(["status", "-leading"]).stderr, /unknown flag: -leading/);
  });

  test("an unknown --service is a usage error naming the known services", () => {
    // "perplexity" is a SERVICES key, so the profile is accepted whether or not it is on disk
    // and the failure is the --service one.
    const r = run(["open", "perplexity", "--service", "notaservice"]);
    assert.equal(r.status, rb.EXIT.USAGE);
    assert.match(r.stderr, /unknown --service "notaservice"/);
    assert.match(r.stderr, /perplexity/);
  });

  test("'generic' with no --url is a usage error, not a crash — and creates nothing", () => {
    // No SERVICES entry matches the name, so the fallback is generic, which has no home.
    // --throwaway gets the new name past the profile gate; the --url check must then fail
    // BEFORE the profile or its state dir is materialised (a usage error costs nothing).
    const r = run(["open", UNKNOWN_PROFILE, "--throwaway"]);
    assert.equal(r.status, rb.EXIT.USAGE, r.stderr);
    assert.match(r.stderr, /--url is required/);
    assert.match(r.stderr, /fell back to\s+"generic"/);
    assert.ok(noTraceOf(UNKNOWN_PROFILE), "a --url usage error must not leave a state dir behind");
  });

  test("--probe and --no-reminder are rejected on the wrong subcommand", () => {
    assert.match(run(["open", "p", "--probe"]).stderr, /--probe applies to 'status' only/);
    assert.equal(run(["open", "p", "--probe"]).status, rb.EXIT.USAGE);
    assert.match(run(["close", "p", "--no-reminder"]).stderr, /--no-reminder applies to 'open' only/);
  });

  test("extra positional arguments are refused rather than ignored", () => {
    const r = run(["status", "perplexity", "extra"]);
    assert.equal(r.status, rb.EXIT.USAGE);
    assert.match(r.stderr, /unexpected extra argument\(s\): extra/);
  });
});

/* ========================================================================== *
 * argv parsing, in-process
 * ========================================================================== */

describe("parseArgs", () => {
  test("parses a full open invocation", () => {
    const opts = rb.parseArgs([
      "open",
      "perplexity",
      "--url",
      "https://www.perplexity.ai/",
      "--label",
      "Login Wall",
      "--run-id",
      "0aa1fce7813c",
    ]);
    assert.equal(opts.subcommand, "open");
    assert.equal(opts.profile, "perplexity");
    assert.equal(opts.url, "https://www.perplexity.ai/");
    assert.equal(opts.label, "Login Wall");
    assert.equal(opts.runId, "0aa1fce7813c");
    assert.equal(opts.reminder, true);
    assert.equal(opts.probe, false);
    assert.equal(opts.help, false);
  });

  test("--flag=value and --flag value are equivalent", () => {
    const a = rb.parseArgs(["open", "p", "--url=https://example.com", "--label=x"]);
    const b = rb.parseArgs(["open", "p", "--url", "https://example.com", "--label", "x"]);
    assert.deepEqual(a, b);
  });

  test("boolean flags take no value", () => {
    assert.equal(rb.parseArgs(["status", "p", "--probe"]).probe, true);
    assert.equal(rb.parseArgs(["open", "p", "--no-reminder"]).reminder, false);
    assert.equal(rb.parseArgs(["open", "p", "--throwaway"]).throwaway, true);
    assert.equal(rb.parseArgs(["open", "p"]).throwaway, false);
    for (const argv of [["status", "p", "--probe=1"], ["open", "p", "--throwaway=yes"]]) {
      assert.throws(
        () => rb.parseArgs(argv),
        (e: Error & { code?: number }) => e.name === "CliError" && e.code === rb.EXIT.USAGE,
        `argv ${JSON.stringify(argv)}`,
      );
    }
  });

  test("the profile positional is optional; flags-only invocations parse with profile null", () => {
    const opts = rb.parseArgs(["open", "--url", "https://example.com", "--throwaway"]);
    assert.equal(opts.subcommand, "open");
    assert.equal(opts.profile, null);
    assert.equal(opts.throwaway, true);
    // A second positional is still a profile, and still validated.
    assert.equal(rb.parseArgs(["close", "scratch-r9"]).profile, "scratch-r9");
    assert.throws(() => rb.parseArgs(["close", "BAD"]), /invalid profile name/);
  });

  test("flags may precede the positional arguments", () => {
    const opts = rb.parseArgs(["--run-id", "abcabcabcabc", "takeover", "perplexity"]);
    assert.equal(opts.subcommand, "takeover");
    assert.equal(opts.profile, "perplexity");
    assert.equal(opts.runId, "abcabcabcabc");
  });

  test("usage failures carry EXIT.USAGE, never a bare Error", () => {
    // ["open"] alone is VALID since the profile became optional; an extra positional is not.
    for (const argv of [[], ["nope", "p"], ["open", "p", "extra"], ["open", "BAD NAME"], ["open", "p", "--zzz"]]) {
      assert.throws(
        () => rb.parseArgs(argv),
        (e: Error & { code?: number }) =>
          e.name === "CliError" && e.code === rb.EXIT.USAGE && e.message.length > 0,
        `argv ${JSON.stringify(argv)} must throw a CliError(3)`,
      );
    }
  });

  test("PROFILE_RE accepts what a real profile looks like and nothing dangerous", () => {
    for (const ok of ["perplexity", "p", "gsc-konrad", "x2", "a".repeat(39)]) {
      assert.ok(rb.PROFILE_RE.test(ok), `${ok} should be valid`);
    }
    for (const bad of ["", ".state", "../x", "-x", "X", "a b", "a_b", "a".repeat(40), "a/b"]) {
      assert.ok(!rb.PROFILE_RE.test(bad), `${bad} should be invalid`);
    }
  });
});

/* ========================================================================== *
 * Profile and state path construction
 * ========================================================================== */

describe("profile paths", () => {
  test("profileDir and stateDir sit under the documented roots", () => {
    assert.equal(rb.profileDir("perplexity"), "/opt/ai-os/browser-profiles/perplexity");
    assert.equal(rb.stateDir("perplexity"), "/opt/ai-os/browser-profiles/.state/perplexity");
    assert.equal(rb.PROFILES_ROOT, "/opt/ai-os/browser-profiles");
    assert.equal(rb.STATE_ROOT, `${rb.PROFILES_ROOT}/.state`);
  });

  test("state lives OUTSIDE the profile dir, so the profile dir stays cookies-only", () => {
    // The header and the docs both promise the profile dir holds session cookies and nothing
    // else. If runtime bookkeeping ever moved inside it, that promise would silently break.
    assert.ok(!rb.stateDir("p").startsWith(`${rb.profileDir("p")}/`));
  });

  test("the state root can never collide with a profile name", () => {
    assert.ok(!rb.PROFILE_RE.test(".state"), ".state must not be a legal profile name");
  });
});

/* ========================================================================== *
 * Label sanitisation and the screenshot path/URL contract
 * ========================================================================== */

describe("sanitiseLabel", () => {
  test("reduces anything to [a-z0-9-]", () => {
    const cases: [string, string][] = [
      ["perplexity-login-wall", "perplexity-login-wall"],
      ["Perplexity Login Wall", "perplexity-login-wall"],
      ["  spaced  out  ", "spaced-out"],
      ["dots.and_underscores", "dots-and-underscores"],
      ["slash/and\\back", "slash-and-back"],
      ["../../etc/passwd", "etc-passwd"],
      ["Ümläut", "ml-ut"],
      ["--leading-and-trailing--", "leading-and-trailing"],
      ["a??b", "a-b"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(rb.sanitiseLabel(input), expected, `sanitiseLabel(${JSON.stringify(input)})`);
    }
  });

  test("never returns an empty string, a leading/trailing dash, or an over-long name", () => {
    for (const input of ["", "   ", "???", "-", "--", null, undefined, 42]) {
      const out = rb.sanitiseLabel(input);
      assert.match(out, /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, `${JSON.stringify(input)} → ${out}`);
    }
    assert.equal(rb.sanitiseLabel(""), "screenshot");
    assert.equal(rb.sanitiseLabel("???"), "screenshot");
    const long = rb.sanitiseLabel("x".repeat(500));
    assert.equal(long.length, 64);
  });

  test("a 64-char cut never leaves a trailing dash in the URL", () => {
    // "ab-ab-…" cut at 64 could land exactly on a dash; the URL must still be clean.
    for (let n = 60; n < 70; n++) {
      const out = rb.sanitiseLabel("ab-".repeat(n));
      assert.ok(!out.endsWith("-"), `n=${n} produced ${out}`);
      assert.match(out, /^[a-z0-9-]+$/);
    }
  });
});

describe("screenshot path and URL construction", () => {
  const date = new Date("2026-08-05T10:15:30.456Z");

  test("compactStamp is second-resolution compact ISO 8601 in UTC", () => {
    assert.equal(rb.compactStamp(date), "20260805T101530Z");
    assert.equal(rb.compactStamp(new Date("2026-01-02T03:04:05Z")), "20260102T030405Z");
  });

  test("the name is <compact-ISO8601>-<label>.png", () => {
    assert.equal(
      rb.screenshotName(date, "Perplexity Login Wall"),
      "20260805T101530Z-perplexity-login-wall.png",
    );
  });

  test("path and URL match the convention the operator-visibility renderer consumes", () => {
    const runId = "7f3a91c2aabb";
    const name = rb.screenshotName(date, "perplexity-login-wall");
    assert.equal(
      rb.screenshotPath(runId, name),
      "/opt/ai-os/uploads/7f3a91c2aabb/20260805T101530Z-perplexity-login-wall.png",
    );
    assert.equal(
      rb.uploadsUrl(runId, name),
      "/api/uploads/7f3a91c2aabb/20260805T101530Z-perplexity-login-wall.png",
    );
    // The URL's last segment must be exactly the on-disk basename — no escaping needed, ever.
    assert.equal(rb.uploadsUrl(runId, name).split("/").pop(), rb.screenshotPath(runId, name).split("/").pop());
  });

  test("every record carries BOTH the absolute path and the /api/uploads URL", () => {
    const rec = rb.screenshotRecord("0aa1fce7813c", date, "smoke");
    assert.ok(rec.path.startsWith(`${rb.UPLOADS_ROOT}/`));
    assert.ok(rec.url.startsWith("/api/uploads/"));
    assert.equal(rec.label, "smoke");
    assert.equal(rec.url_servable, true);
  });

  test("a URL built from any label is always route-valid", () => {
    for (const label of ["../../etc/passwd", "a b c", "Ümläut??", ""]) {
      const rec = rb.screenshotRecord("0aa1fce7813c", date, label);
      assert.match(rec.url, /^\/api\/uploads\/[a-z0-9]+\/\d{8}T\d{6}Z-[a-z0-9-]+\.png$/, label);
      assert.ok(!rec.url.includes(".."), `path traversal survived: ${rec.url}`);
    }
  });
});

describe("run id resolution and servability", () => {
  test("--run-id wins, then FORGE_RUN_ID, then the sentinel", () => {
    assert.deepEqual(rb.resolveRunId("0aa1fce7813c", { FORGE_RUN_ID: "ffffffffffff" }), {
      runId: "0aa1fce7813c",
      source: "flag",
    });
    assert.deepEqual(rb.resolveRunId(null, { FORGE_RUN_ID: "ffffffffffff" }), {
      runId: "ffffffffffff",
      source: "env:FORGE_RUN_ID",
    });
    assert.deepEqual(rb.resolveRunId(null, {}), {
      runId: rb.ADHOC_RUN_ID,
      source: "fallback-sentinel",
    });
  });

  test("an empty or unusable run id falls back instead of producing an empty path segment", () => {
    for (const bad of ["", "   ", "???", "///"]) {
      const { runId, source } = rb.resolveRunId(bad, {});
      assert.equal(runId, rb.ADHOC_RUN_ID, `${JSON.stringify(bad)} must not become a path segment`);
      assert.equal(source, "fallback-sentinel");
    }
    assert.equal(rb.resolveRunId(null, { FORGE_RUN_ID: "  " }).source, "fallback-sentinel");
  });

  test("THE SENTINEL IS SERVABLE — an 'adhoc' style literal would 400", () => {
    // forge-control/src/routes/uploads.ts gates the id on /^[a-f0-9]{12}$/ and 400s the rest,
    // so a mnemonic fallback would make every ad-hoc screenshot unviewable in the Console.
    assert.ok(UPLOADS_ROUTE_ID_RE.test(rb.ADHOC_RUN_ID), `${rb.ADHOC_RUN_ID} must satisfy the route`);
    assert.ok(!UPLOADS_ROUTE_ID_RE.test("adhoc"));
    assert.equal(rb.screenshotRecord(rb.ADHOC_RUN_ID, new Date(), "x").url_servable, true);
  });

  test("the servability flag agrees with the real route regex, and is honest when it fails", () => {
    for (const runId of ["0aa1fce7813c", "deadbeefcafe", "abc", "4120f785fd86414c9a04f10b2cd0c365", "zzzz"]) {
      assert.equal(
        rb.isServableRunId(runId),
        UPLOADS_ROUTE_ID_RE.test(runId),
        `${runId}: the flag must track forge-control's ID_RE exactly`,
      );
    }
    // A non-servable id still gets the documented path — the convention is never mangled.
    const rec = rb.screenshotRecord("abc", new Date("2026-08-05T10:15:30Z"), "x");
    assert.equal(rec.path, "/opt/ai-os/uploads/abc/20260805T101530Z-x.png");
    assert.equal(rec.url_servable, false);
  });

  test("sanitiseRunId strips dashes — a UUID becomes one path segment, not several", () => {
    assert.equal(rb.sanitiseRunId("4120f785-fd86-414c"), "4120f785fd86414c");
    assert.equal(rb.sanitiseRunId("../../etc"), "etc");
    assert.equal(rb.sanitiseRunId(""), null);
  });
});

/* ========================================================================== *
 * Display and port allocation
 * ========================================================================== */

describe("display allocation", () => {
  test("a profile's preferred display is deterministic and inside the managed range", () => {
    for (const profile of ["perplexity", "gsc", "scratch", "a", "z".repeat(39)]) {
      const first = rb.displaySlot(profile);
      assert.equal(first, rb.displaySlot(profile), "must be stable across calls");
      assert.ok(Number.isInteger(first));
      assert.ok(first >= rb.DISPLAY_BASE && first < rb.DISPLAY_BASE + rb.DISPLAY_SPAN, `${profile} → :${first}`);
    }
  });

  test("ports are derived from the display, so two displays can never share one", () => {
    const seen = new Map<number, number>();
    for (let n = rb.DISPLAY_BASE; n < rb.DISPLAY_BASE + rb.DISPLAY_SPAN; n++) {
      const p = rb.portsForDisplay(n);
      assert.equal(p.display, `:${n}`);
      assert.equal(p.vncPort, rb.VNC_PORT_BASE + n);
      assert.equal(p.novncPort, rb.NOVNC_PORT_BASE + (n - rb.DISPLAY_BASE));
      assert.equal(seen.has(p.vncPort), false, `vnc port ${p.vncPort} reused`);
      assert.equal(seen.has(p.novncPort), false, `novnc port ${p.novncPort} collides with a vnc port`);
      seen.set(p.vncPort, n);
      seen.set(p.novncPort, n);
    }
  });

  test("a display outside the managed range is a runtime error, not a wild port", () => {
    for (const n of [0, 1, rb.DISPLAY_BASE - 1, rb.DISPLAY_BASE + rb.DISPLAY_SPAN, 1.5, Number.NaN]) {
      assert.throws(
        () => rb.portsForDisplay(n),
        (e: Error & { code?: number }) => e.name === "CliError" && e.code === rb.EXIT.RUNTIME,
        `display ${n}`,
      );
    }
  });

  test("hash distribution: 200 profile names spread over the display span", () => {
    // Not a guarantee of collision-freedom — the registry provides that. This only checks the
    // hash is not degenerate, which is what would make the registry probe do all the work.
    const slots = new Set<number>();
    for (let i = 0; i < 200; i++) slots.add(rb.displaySlot(`profile-${i}`));
    assert.ok(slots.size > rb.DISPLAY_SPAN / 2, `only ${slots.size} distinct slots for 200 names`);
  });

  test("fnv1a32 is a stable unsigned 32-bit hash", () => {
    assert.equal(rb.fnv1a32(""), 0x811c9dc5);
    assert.equal(rb.fnv1a32("a"), 0xe40c292c);
    assert.ok(rb.fnv1a32("perplexity") >= 0 && rb.fnv1a32("perplexity") <= 0xffffffff);
  });
});

describe("takeover URLs", () => {
  test("the noVNC URL is loopback-only and autoconnects", () => {
    const url = rb.novncUrl(6912);
    assert.match(url, /^http:\/\/127\.0\.0\.1:6912\/vnc\.html\?/);
    assert.match(url, /autoconnect=1/);
  });

  test("the SSH tunnel command forwards the noVNC port to loopback on this box", () => {
    const cmd = rb.sshTunnelCommand(6912, "root@example.invalid");
    assert.equal(cmd, "ssh -N -L 6912:127.0.0.1:6912 root@example.invalid");
  });

  test("no URL the tool prints ever names a non-loopback bind address", () => {
    for (let n = rb.DISPLAY_BASE; n < rb.DISPLAY_BASE + rb.DISPLAY_SPAN; n++) {
      const { novncPort } = rb.portsForDisplay(n);
      assert.ok(rb.novncUrl(novncPort).includes("127.0.0.1"));
      assert.ok(!/0\.0\.0\.0|\[::\]/.test(rb.novncUrl(novncPort)));
    }
  });
});

/* ========================================================================== *
 * The SERVICES table and service resolution
 * ========================================================================== */

describe("SERVICES table", () => {
  test("Perplexity is a table ENTRY, not a hardcoded special case", () => {
    // The whole point of the table: the next logged-in surface is a new object, not new code.
    for (const [key, svc] of Object.entries(rb.SERVICES)) {
      assert.ok(Array.isArray(svc.hosts), `${key}.hosts`);
      assert.ok(Array.isArray(svc.loginUrlPatterns), `${key}.loginUrlPatterns`);
      assert.ok(Array.isArray(svc.loggedOutSelectors), `${key}.loggedOutSelectors`);
      assert.ok(Array.isArray(svc.loggedInSelectors), `${key}.loggedInSelectors`);
      assert.equal(typeof svc.title, "string");
      assert.ok(svc.home === null || /^https:\/\//.test(svc.home), `${key}.home`);
    }
    assert.ok("perplexity" in rb.SERVICES);
    assert.ok("generic" in rb.SERVICES);
  });

  test("generic claims nothing about being logged IN", () => {
    // A fallback that guessed "authenticated" would be the worst possible default.
    assert.deepEqual(rb.SERVICES.generic.loggedInSelectors, []);
    assert.deepEqual(rb.SERVICES.generic.loggedOutSelectors, []);
    assert.equal(rb.SERVICES.generic.home, null);
  });

  test("resolveService precedence: --service, then url host, then profile name, then generic", () => {
    assert.equal(rb.resolveService({ service: "perplexity" }).key, "perplexity");
    assert.equal(rb.resolveService({ url: "https://www.perplexity.ai/search" }).key, "perplexity");
    assert.equal(rb.resolveService({ url: "https://perplexity.ai/" }).key, "perplexity");
    assert.equal(rb.resolveService({ profile: "perplexity" }).key, "perplexity");
    assert.equal(rb.resolveService({ profile: "scratch" }).key, "generic");
    assert.equal(rb.resolveService({}).key, "generic");
  });

  test("an explicit --url OUTRANKS the profile name — wrong selectors are worse than none", () => {
    // A profile called "perplexity" pointed at example.com must be evaluated with generic
    // signals. Applying Perplexity's logged-in selectors to another site would let the tool
    // claim a session is authenticated on evidence from a page it never visited.
    assert.equal(rb.resolveService({ url: "https://example.com/", profile: "perplexity" }).key, "generic");
    // ...but an explicit --service still wins over both.
    assert.equal(
      rb.resolveService({ service: "perplexity", url: "https://example.com/", profile: "scratch" }).key,
      "perplexity",
    );
  });

  test("a lookalike host does not match perplexity", () => {
    for (const url of [
      "https://perplexity.ai.evil.example/",
      "https://notperplexity.ai/",
      "https://example.com/perplexity.ai",
    ]) {
      assert.equal(rb.resolveService({ url }).key, "generic", url);
    }
  });

  test("a malformed --url is a usage error, not a silent generic fallback", () => {
    assert.throws(
      () => rb.resolveService({ url: "not a url" }),
      (e: Error & { code?: number }) => e.name === "CliError" && e.code === rb.EXIT.USAGE,
    );
  });

  test("resolveTargetUrl prefers --url, falls back to the service home, else errors", () => {
    const perplexity = rb.resolveService({ service: "perplexity" });
    const generic = rb.resolveService({ service: "generic" });
    assert.equal(rb.resolveTargetUrl({ url: "https://x.example/", profile: "p" }, perplexity), "https://x.example/");
    assert.equal(rb.resolveTargetUrl({ url: null, profile: "p" }, perplexity), rb.SERVICES.perplexity.home);
    assert.throws(
      () => rb.resolveTargetUrl({ url: null, profile: "scratch" }, generic),
      (e: Error & { code?: number }) => e.name === "CliError" && e.code === rb.EXIT.USAGE,
    );
  });
});

/* ========================================================================== *
 * THE LOGIN-WALL EVALUATOR — synthetic signals, no browser
 * ========================================================================== */

describe("evaluateLoginWall", () => {
  const perplexity = rb.resolveService({ service: "perplexity" });
  const generic = rb.resolveService({ service: "generic" });

  test("a redirect to a sign-in path is a login wall", () => {
    const v = rb.evaluateLoginWall(perplexity, { finalUrl: "https://www.perplexity.ai/sign-in" });
    assert.equal(v.needsLogin, true);
    assert.equal(v.authenticated, false);
    assert.equal(v.decision, "hard-signal");
    assert.match(v.reasons.join("\n"), /final url matches login pattern/);
  });

  test("/login and a Google accounts redirect are both walls", () => {
    assert.equal(rb.evaluateLoginWall(generic, { finalUrl: "https://x.example/login" }).needsLogin, true);
    assert.equal(
      rb.evaluateLoginWall(generic, {
        finalUrl: "https://accounts.google.com/o/oauth2/v2/auth?client_id=x",
      }).needsLogin,
      true,
    );
    // /signin without the dash too — the pattern is /sign-?in/.
    assert.equal(rb.evaluateLoginWall(generic, { finalUrl: "https://x.example/signin" }).needsLogin, true);
  });

  test("a visible password field is a login wall on any service", () => {
    const v = rb.evaluateLoginWall(generic, {
      finalUrl: "https://x.example/account",
      passwordFieldCount: 1,
    });
    assert.equal(v.needsLogin, true);
    assert.match(v.reasons.join("\n"), /1 visible password field/);
  });

  test("a logged-out selector alone is a wall (soft signal)", () => {
    const v = rb.evaluateLoginWall(perplexity, {
      finalUrl: "https://www.perplexity.ai/",
      loggedOutHits: ['a[href*="/sign-in"]'],
    });
    assert.equal(v.needsLogin, true);
    assert.equal(v.decision, "logged-out-selector");
  });

  test("a logged-in selector means authenticated", () => {
    const v = rb.evaluateLoginWall(perplexity, {
      finalUrl: "https://www.perplexity.ai/",
      loggedInHits: ['textarea[placeholder*="Ask" i]'],
    });
    assert.equal(v.needsLogin, false);
    assert.equal(v.authenticated, true);
    assert.equal(v.decision, "logged-in-selector");
  });

  test("a logged-in selector BEATS a stale logged-out selector", () => {
    // Sites routinely leave a hidden-but-matching "Sign in" node in the DOM after auth.
    const v = rb.evaluateLoginWall(perplexity, {
      finalUrl: "https://www.perplexity.ai/",
      loggedOutHits: ['button:has-text("Sign in")'],
      loggedInHits: ['a[href*="/settings/account"]'],
    });
    assert.equal(v.needsLogin, false);
    assert.equal(v.authenticated, true);
  });

  test("a HARD signal beats a logged-in selector, and says so", () => {
    const v = rb.evaluateLoginWall(perplexity, {
      finalUrl: "https://www.perplexity.ai/sign-in",
      loggedInHits: ['a[href*="/settings/account"]'],
    });
    assert.equal(v.needsLogin, true);
    assert.equal(v.authenticated, false);
    assert.equal(v.decision, "hard-signal-overrides-logged-in");
  });

  test("SILENCE PROVES NOTHING: no signals ⇒ needsLogin false, authenticated NULL", () => {
    const v = rb.evaluateLoginWall(generic, { finalUrl: "https://example.com/" });
    assert.equal(v.needsLogin, false);
    assert.equal(v.authenticated, null, "the tool must never guess a session is good");
    assert.equal(v.decision, "no-signal");
    assert.deepEqual(v.reasons, []);
  });

  test("a page that never navigated carries no signal and does not throw", () => {
    for (const finalUrl of ["", "about:blank", "chrome://newtab/"]) {
      const v = rb.evaluateLoginWall(generic, { finalUrl });
      assert.equal(v.needsLogin, false, finalUrl);
      assert.equal(v.authenticated, null, finalUrl);
    }
  });

  test("missing signal fields default safely instead of throwing", () => {
    const v = rb.evaluateLoginWall(perplexity, {});
    assert.equal(v.needsLogin, false);
    assert.equal(v.authenticated, null);
  });

  test("a query string cannot smuggle a false positive past the host check", () => {
    // The pattern is matched against pathname+search, so ?next=/login DOES match — that is
    // intended (a ?next=/login redirect target is a login flow), and it is asserted rather
    // than left as an accident.
    const v = rb.evaluateLoginWall(generic, { finalUrl: "https://x.example/home?next=/login" });
    assert.equal(v.needsLogin, true);
    // But a path that merely CONTAINS the word is not a match — \b anchors the segment.
    assert.equal(rb.evaluateLoginWall(generic, { finalUrl: "https://x.example/loginary" }).needsLogin, false);
    assert.equal(rb.evaluateLoginWall(generic, { finalUrl: "https://x.example/blogin" }).needsLogin, false);
  });

  test("reasons are always populated when a decision is not 'no-signal'", () => {
    const decided = [
      rb.evaluateLoginWall(perplexity, { finalUrl: "https://www.perplexity.ai/sign-in" }),
      rb.evaluateLoginWall(generic, { finalUrl: "https://x/", passwordFieldCount: 2 }),
      rb.evaluateLoginWall(perplexity, { finalUrl: "https://x/", loggedOutHits: ["a"] }),
      rb.evaluateLoginWall(perplexity, { finalUrl: "https://x/", loggedInHits: ["b"] }),
    ];
    for (const v of decided) {
      assert.ok(v.reasons.length > 0, `${v.decision} must explain itself`);
    }
  });
});

/* ========================================================================== *
 * The login reminder: text, and the dedup window
 * ========================================================================== */

describe("buildLoginReminderText", () => {
  const input = {
    profile: "perplexity",
    service: "perplexity",
    serviceTitle: "Perplexity",
    runId: "0aa1fce7813c",
  };

  test("names the clickable takeover URL, the profile, and the service to log into", () => {
    const text = rb.buildLoginReminderText(input);
    assert.ok(
      text.includes(rb.takeoverUrl("0aa1fce7813c")),
      "the exact takeover URL must be in the reminder",
    );
    assert.ok(text.startsWith("Research browser needs a ONE-TIME login"));
    assert.ok(text.includes('profile "perplexity"'));
    assert.ok(text.includes("Perplexity"));
  });

  test("carries no ssh command — the whole point of the takeover URL is no tunnel", () => {
    const text = rb.buildLoginReminderText(input);
    assert.ok(!text.includes("ssh "), "an ssh command in the reminder means the tunnel is back");
  });

  test("osBaseUrl overrides RESEARCH_BROWSER_OS_BASE_URL's default host", () => {
    const text = rb.buildLoginReminderText({ ...input, osBaseUrl: "https://example.invalid" });
    assert.ok(text.includes("https://example.invalid/takeover/0aa1fce7813c"));
    assert.ok(!text.includes(rb.OS_BASE_URL));
  });

  test("fits forge-control's 500-char limit — over-length is a 400, i.e. NO notification", () => {
    const text = rb.buildLoginReminderText(input);
    assert.ok(
      text.length <= rb.REMINDER_TEXT_MAX,
      `${text.length} chars, max ${rb.REMINDER_TEXT_MAX} — forge-control would reject this`,
    );
  });

  test("still fits with the longest legal profile name and a long service title", () => {
    const text = rb.buildLoginReminderText({
      ...input,
      profile: "a".repeat(39),
      serviceTitle: "Some Service With A Fairly Long Name",
    });
    assert.ok(text.length <= rb.REMINDER_TEXT_MAX, `${text.length} chars`);
  });

  test("an over-long reminder throws instead of being silently rejected later", () => {
    assert.throws(
      () => rb.buildLoginReminderText({ ...input, serviceTitle: "T".repeat(600) }),
      (e: Error & { code?: number }) => e.name === "CliError" && e.code === rb.EXIT.RUNTIME,
    );
  });

  test("carries the machine-readable dedup marker", () => {
    const text = rb.buildLoginReminderText(input);
    assert.ok(text.includes(rb.reminderMarker("perplexity", "perplexity")));
  });

  test("promises no password is stored — the reminder is where Konrad reads that", () => {
    assert.match(rb.buildLoginReminderText(input), /nothing stores your password/i);
  });
});

/* ========================================================================== *
 * The run→profile marker (browser_state.json) resolveProfileForRun reads
 * ========================================================================== */

describe("browserStatePath / writeBrowserStateMarker", () => {
  test("the marker path is <UPLOADS_ROOT>/<runId>/browser_state.json", () => {
    assert.equal(rb.browserStatePath("0aa1fce7813c"), `${rb.UPLOADS_ROOT}/0aa1fce7813c/browser_state.json`);
  });

  /* Round-4 review, finding 3: browser_state.json is one file per RUN, so a run
   * that drives two profiles keeps only the last writer's. The per-profile
   * marker is keyed by run AND profile, and forge-control's
   * resolveProfileForRun reads THIS directory first
   * (browser-takeover.ts, PROFILE_MARKER_DIR). The two must agree on the layout
   * or the marker is an orphan the viewer silently ignores. */
  test("the per-profile marker is <UPLOADS_ROOT>/<runId>/browser-state/<profile>.json", () => {
    assert.equal(
      rb.profileMarkerPath("0aa1fce7813c", "os-ui"),
      `${rb.UPLOADS_ROOT}/0aa1fce7813c/browser-state/os-ui.json`,
    );
    // Two profiles under ONE run get two files — that is the whole fix.
    assert.notEqual(
      rb.profileMarkerPath("0aa1fce7813c", "os-ui"),
      rb.profileMarkerPath("0aa1fce7813c", "perplexity"),
    );
  });

  test("the per-profile marker dir matches forge-control's PROFILE_MARKER_DIR", () => {
    // Read from the consumer, not restated as a literal: a rename on either side
    // must break this, which is the only reason the assertion is worth having.
    const dir = rb.profileMarkerPath("0aa1fce7813c", "os-ui").split("/").at(-2);
    assert.equal(dir, PROFILE_MARKER_DIR);
  });

  test("the ADHOC_RUN_ID sentinel is skipped — no run row will ever resolve it", () => {
    // Skipped, not written: assert on the return value only. Writing under UPLOADS_ROOT is a
    // live-filesystem side effect this suite deliberately never takes (see file header) — the
    // real write path was exercised by hand, out of the worktree, against a throwaway run id.
    const result = rb.writeBrowserStateMarker({
      runId: rb.ADHOC_RUN_ID,
      profile: "perplexity",
      service: "perplexity",
      novncPort: 6912,
    });
    assert.equal(result.written, false);
  });
});

describe("parsePgTimestamp", () => {
  test("reads Postgres timestamptz, which is not valid ISO 8601", () => {
    const ms = rb.parsePgTimestamp("2026-08-05 15:59:23.232128+00");
    assert.equal(ms, Date.parse("2026-08-05T15:59:23.232Z"));
  });

  test("handles a real ISO string and a non-zero bare offset", () => {
    assert.equal(rb.parsePgTimestamp("2026-08-05T15:59:23.000Z"), Date.parse("2026-08-05T15:59:23Z"));
    assert.equal(rb.parsePgTimestamp("2026-08-05 15:59:23+02"), Date.parse("2026-08-05T13:59:23Z"));
  });

  test("returns null rather than a wrong number for anything unreadable", () => {
    for (const bad of ["", "   ", "not a date", null, undefined, 12345, {}]) {
      assert.equal(rb.parsePgTimestamp(bad), null, JSON.stringify(bad));
    }
  });
});

describe("findRecentLoginReminder — the dedup window", () => {
  const nowMs = Date.parse("2026-08-05T12:00:00Z");
  const windowMs = rb.REMINDER_DEDUP_WINDOW_MS;
  const opts = { profile: "perplexity", service: "perplexity", nowMs, windowMs };
  const marker = rb.reminderMarker("perplexity", "perplexity");
  const pg = (iso: string) => iso.replace("T", " ").replace("Z", "+00");

  test("the window is one hour, as the brief specifies", () => {
    assert.equal(windowMs, 60 * 60 * 1000);
  });

  test("an identical reminder from 10 minutes ago suppresses a second one", () => {
    const r = rb.findRecentLoginReminder(
      [{ id: "r1", text: `blah ${marker}`, status: "pending", created_at: pg("2026-08-05T11:50:00.000Z") }],
      opts,
    );
    assert.equal(r.match?.id, "r1");
    assert.equal(r.ageMs, 10 * 60 * 1000);
  });

  test("an identical reminder from 61 minutes ago does NOT suppress", () => {
    const r = rb.findRecentLoginReminder(
      [{ id: "r1", text: marker, status: "pending", created_at: pg("2026-08-05T10:59:00.000Z") }],
      opts,
    );
    assert.equal(r.match, null);
  });

  test("the boundary is inclusive at exactly one hour", () => {
    const at = (iso: string) =>
      rb.findRecentLoginReminder([{ id: "r", text: marker, status: "pending", created_at: pg(iso) }], opts).match;
    assert.notEqual(at("2026-08-05T11:00:00.000Z"), null, "exactly 60 min ⇒ duplicate");
    assert.equal(at("2026-08-05T10:59:59.999Z"), null, "one ms past the window ⇒ not a duplicate");
  });

  test("a different profile or a different service is NOT a duplicate", () => {
    const other = [
      { id: "a", text: rb.reminderMarker("gsc", "perplexity"), status: "pending", created_at: pg("2026-08-05T11:59:00.000Z") },
      { id: "b", text: rb.reminderMarker("perplexity", "gemini"), status: "pending", created_at: pg("2026-08-05T11:59:00.000Z") },
    ];
    assert.equal(rb.findRecentLoginReminder(other, opts).match, null);
  });

  test("an unrelated reminder is never matched, however recent", () => {
    const r = rb.findRecentLoginReminder(
      [{ id: "x", text: "P6 R20 smoke — check #1a of 2", status: "pending", created_at: pg("2026-08-05T11:59:59.000Z") }],
      opts,
    );
    assert.equal(r.match, null);
  });

  test("a dismissed reminder does not suppress a new one", () => {
    const r = rb.findRecentLoginReminder(
      [{ id: "d", text: marker, status: "dismissed", created_at: pg("2026-08-05T11:59:00.000Z") }],
      opts,
    );
    assert.equal(r.match, null, "a dismissed reminder is no longer telling Konrad anything");
  });

  test("a delivered-but-not-dismissed reminder DOES suppress inside the window", () => {
    const r = rb.findRecentLoginReminder(
      [{ id: "s", text: marker, status: "delivered", created_at: pg("2026-08-05T11:30:00.000Z") }],
      opts,
    );
    assert.equal(r.match?.id, "s");
  });

  test("AN UNREADABLE created_at IS NOT A DUPLICATE, and is reported", () => {
    // Asymmetric failure modes: a duplicate reminder is phone noise, a suppressed one means
    // Konrad is never told and the research lane is stuck forever. Noise is the cheaper bug.
    const r = rb.findRecentLoginReminder(
      [{ id: "weird", text: marker, status: "pending", created_at: "who knows" }],
      opts,
    );
    assert.equal(r.match, null);
    assert.deepEqual(
      r.skipped.map((s) => s.id),
      ["weird"],
    );
    assert.match(r.skipped[0].reason, /unreadable created_at/);
  });

  test("a future created_at (clock skew) is not treated as a duplicate", () => {
    const r = rb.findRecentLoginReminder(
      [{ id: "f", text: marker, status: "pending", created_at: pg("2026-08-05T12:30:00.000Z") }],
      opts,
    );
    assert.equal(r.match, null);
  });

  test("an empty, missing or malformed reminder list is handled, not crashed on", () => {
    for (const list of [[], undefined]) {
      assert.equal(rb.findRecentLoginReminder(list, opts).match, null);
    }
    const junk = [{}, { text: 123 }, { text: null }] as unknown as Reminder[];
    assert.equal(rb.findRecentLoginReminder(junk, opts).match, null);
  });

  test("the first matching reminder inside the window wins", () => {
    const r = rb.findRecentLoginReminder(
      [
        { id: "old", text: marker, status: "pending", created_at: pg("2026-08-05T09:00:00.000Z") },
        { id: "recent", text: marker, status: "pending", created_at: pg("2026-08-05T11:55:00.000Z") },
      ],
      opts,
    );
    assert.equal(r.match?.id, "recent");
  });
});

/* ========================================================================== *
 * R705 finding 1 — pruning the reminders this tool produces
 *
 * The dedup itself was 16 rows from failing open because it scanned a
 * 100-row, pending-first page in which the newest DELIVERED login reminder is
 * the first casualty of truncation. Scoping the query by marker (newest first)
 * is the fix; this is the other half — nothing ever pruned delivered rows, so
 * the matching set grew without bound and would eventually re-create the same
 * truncation problem inside the filtered query.
 * ========================================================================== */

describe("selectStaleLoginReminders — pruning spent reminders", () => {
  const nowMs = Date.parse("2026-08-05T12:00:00Z");
  const windowMs = rb.REMINDER_DEDUP_WINDOW_MS;
  const opts = { profile: "perplexity", service: "perplexity", nowMs, windowMs };
  const marker = rb.reminderMarker("perplexity", "perplexity");
  const pg = (iso: string) => iso.replace("T", " ").replace("Z", "+00");
  const rem = (id: string, iso: string, over: Partial<Reminder> = {}): Reminder => ({
    id,
    text: `Research browser needs a login ${marker}`,
    status: "delivered",
    created_at: pg(iso),
    ...over,
  });

  test("a match older than the window is stale", () => {
    assert.deepEqual(rb.selectStaleLoginReminders([rem("old", "2026-08-05T09:00:00.000Z")], opts), ["old"]);
  });

  test("a match INSIDE the window is never pruned — it is why this run deduped", () => {
    assert.deepEqual(rb.selectStaleLoginReminders([rem("fresh", "2026-08-05T11:30:00.000Z")], opts), []);
  });

  test("the boundary matches findRecentLoginReminder exactly — no row falls between them", () => {
    // A row that suppresses must never also be dismissed, and vice versa. Sweeping the
    // boundary in both functions is the only way to know the two agree.
    for (const iso of [
      "2026-08-05T12:00:00.000Z",
      "2026-08-05T11:00:00.001Z",
      "2026-08-05T11:00:00.000Z", // exactly one hour: a duplicate, inclusive
      "2026-08-05T10:59:59.999Z", // one ms past: no longer a duplicate
      "2026-08-05T09:00:00.000Z",
    ]) {
      const list = [rem("r", iso, { status: "pending" })];
      const suppresses = rb.findRecentLoginReminder(list, opts).match !== null;
      const pruned = rb.selectStaleLoginReminders(list, opts).length > 0;
      assert.notEqual(suppresses, pruned, `${iso}: a row must be exactly one of suppressing or spent`);
    }
  });

  test("the reminder just created is excluded by id, whatever its timestamp says", () => {
    // Clock skew between this box and Postgres must not let a run dismiss its own reminder.
    const list = [rem("new", "2026-08-05T09:00:00.000Z")];
    assert.deepEqual(rb.selectStaleLoginReminders(list, { ...opts, exceptId: "new" }), []);
  });

  test("another profile or service is never pruned", () => {
    const others = [
      { id: "a", text: rb.reminderMarker("gsc", "perplexity"), status: "delivered", created_at: pg("2026-08-05T09:00:00.000Z") },
      { id: "b", text: rb.reminderMarker("perplexity", "gemini"), status: "delivered", created_at: pg("2026-08-05T09:00:00.000Z") },
      { id: "c", text: "P6 R20 smoke — check #1a of 2", status: "delivered", created_at: pg("2026-08-05T09:00:00.000Z") },
    ];
    assert.deepEqual(rb.selectStaleLoginReminders(others, opts), []);
  });

  test("an already-dismissed row is not dismissed again", () => {
    assert.deepEqual(
      rb.selectStaleLoginReminders([rem("d", "2026-08-05T09:00:00.000Z", { status: "dismissed" })], opts),
      [],
    );
  });

  test("an unreadable created_at is LEFT ALONE rather than guessed at", () => {
    // Symmetrical to the dedup's rule and for the same reason: the destructive action is the
    // one that needs certainty. Dismissing on a timestamp nobody could parse is a guess.
    assert.deepEqual(rb.selectStaleLoginReminders([rem("weird", "1970", { created_at: "who knows" })], opts), []);
  });

  test("a row with no usable id is skipped — there is nothing to dismiss it by", () => {
    const list = [{ text: marker, status: "delivered", created_at: pg("2026-08-05T09:00:00.000Z") }];
    assert.deepEqual(rb.selectStaleLoginReminders(list, opts), []);
  });

  test("an empty, missing or malformed list is handled, not crashed on", () => {
    assert.deepEqual(rb.selectStaleLoginReminders([], opts), []);
    assert.deepEqual(rb.selectStaleLoginReminders(undefined, opts), []);
    const junk = [{}, { text: 123 }, { text: null }] as unknown as Reminder[];
    assert.deepEqual(rb.selectStaleLoginReminders(junk, opts), []);
  });

  test("every spent row is returned, not just the first", () => {
    const list = [
      rem("s1", "2026-08-05T09:00:00.000Z"),
      rem("keep", "2026-08-05T11:59:00.000Z"),
      rem("s2", "2026-08-05T08:00:00.000Z"),
    ];
    assert.deepEqual(rb.selectStaleLoginReminders(list, opts), ["s1", "s2"]);
  });
});

/* ========================================================================== *
 * R705 finding 4 — start.lock staleness
 * ========================================================================== */

describe("classifyStartLock", () => {
  const grace = rb.LOCK_PID_GRACE_MS;

  test("a lock whose holder is alive is never broken", () => {
    const v = rb.classifyStartLock({ pid: 4242, dirAgeMs: 60_000, holderAlive: true });
    assert.equal(v.stale, false);
    assert.match(v.reason, /4242 is alive/);
  });

  test("a lock whose holder is gone IS broken — this is the 90s-burn bug", () => {
    // The winner dying between mkdirSync and writing session.json used to cost the next
    // invocation the full STARTUP_TIMEOUT_MS before it could even try.
    const v = rb.classifyStartLock({ pid: 4242, dirAgeMs: 1_000, holderAlive: false });
    assert.equal(v.stale, true);
    assert.match(v.reason, /4242 is gone/);
  });

  test("a pid-less lock inside the write grace is respected — mkdir and the pid write race", () => {
    const v = rb.classifyStartLock({ pid: null, dirAgeMs: grace - 1, holderAlive: false });
    assert.equal(v.stale, false, "the holder may be one syscall away from writing its pid");
  });

  test("a pid-less lock past the grace is stale — the holder died mid-creation", () => {
    const v = rb.classifyStartLock({ pid: null, dirAgeMs: grace + 1, holderAlive: false });
    assert.equal(v.stale, true);
    assert.match(v.reason, /no pid file after/);
  });

  test("the grace boundary is exclusive, and overridable for testing", () => {
    assert.equal(rb.classifyStartLock({ pid: null, dirAgeMs: grace, holderAlive: false }).stale, false);
    assert.equal(rb.classifyStartLock({ pid: null, dirAgeMs: 11, holderAlive: false, graceMs: 10 }).stale, true);
  });

  test("the grace is short enough to be cheap and long enough to be safe", () => {
    assert.ok(grace >= 1_000 && grace < rb.STARTUP_TIMEOUT_MS, `grace ${grace}ms`);
  });
});

/* ========================================================================== *
 * R705 finding 2 — the orphaned X/VNC stack
 * ========================================================================== */

describe("classifyTakeoverOwner", () => {
  test("a stack whose supervisor is dead but whose processes live IS reaped", () => {
    // The leak itself: Xvfb/x11vnc/websockify are detached + unref'd, so a SIGKILLed
    // supervisor left all three running with nothing anywhere able to reap them.
    const v = rb.classifyTakeoverOwner({ supervisorPid: 7, ownerAlive: false, anyProcessLive: true });
    assert.equal(v.reap, true);
    assert.match(v.reason, /pid 7 is dead but its stack is still up/);
  });

  test("a stack with a live supervisor is left alone", () => {
    assert.equal(rb.classifyTakeoverOwner({ supervisorPid: 7, ownerAlive: true, anyProcessLive: true }).reap, false);
  });

  test("a stack nobody owns is left alone — `takeover` raised it on purpose", () => {
    for (const supervisorPid of [null, undefined, 0, -1]) {
      const v = rb.classifyTakeoverOwner({ supervisorPid, ownerAlive: false, anyProcessLive: true });
      assert.equal(v.reap, false, `supervisorPid ${String(supervisorPid)}`);
      assert.match(v.reason, /raised it deliberately/);
    }
  });

  test("a dead supervisor with a dead stack clears the state file without signalling anything", () => {
    const v = rb.classifyTakeoverOwner({ supervisorPid: 7, ownerAlive: false, anyProcessLive: false });
    assert.equal(v.reap, false, "there is nothing left to kill");
    assert.equal(v.stateOnly, true, "but the stale record must not linger");
  });
});

/* ========================================================================== *
 * aios-takeover-usable R8 — teardown must actually tear down
 *
 * B5 measured (2026-08-26, profile testtextinput, :129): after Done, x11vnc logged
 * "caught signal: 15", ignored a second SIGTERM, and held :6029 for seven minutes in
 * futex_wait until a SIGKILL. The old teardown sent one SIGTERM per pid, deleted
 * takeover.json and returned — so every later open on the profile hung with no record
 * of the orphan anywhere. These tests use REAL processes that really ignore SIGTERM;
 * a cooperative stub would prove nothing about this bug.
 * ========================================================================== */

/**
 * A stand-in for x11vnc/websockify/Xvfb: optionally ignores SIGTERM, optionally listens on a
 * loopback port, and reports both its port and every SIGTERM it receives on stdout so the
 * test can assert the signal ARRIVED and was ignored — not merely that the process survived.
 * The extra argv tokens land in /proc/<pid>/cmdline, which is what pidCmdlineMatches reads.
 */
const STUB_SCRIPT = [
  'const net = require("node:net");',
  'const ignore = process.argv.includes("--ignore-sigterm");',
  'process.on("SIGTERM", () => { process.stdout.write("TERM\\n"); if (!ignore) process.exit(0); });',
  'if (process.argv.includes("--listen")) {',
  '  const s = net.createServer();',
  '  s.listen(0, "127.0.0.1", () => process.stdout.write("PORT " + s.address().port + "\\n"));',
  '} else { process.stdout.write("PORT 0\\n"); }',
  "setInterval(() => {}, 1 << 30);",
].join("\n");

interface Stub {
  child: ChildProcess;
  pid: number;
  port: number;
  token: string;
  termReceivedAt: () => number | null;
  exitedAt: () => number | null;
  exit: () => Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function spawnStub(token: string, opts: { ignoreSigterm: boolean; listen: boolean }): Promise<Stub> {
  const args = ["-e", STUB_SCRIPT, "--", token];
  if (opts.ignoreSigterm) args.push("--ignore-sigterm");
  if (opts.listen) args.push("--listen");
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
  let termAt: number | null = null;
  let exitAt: number | null = null;
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      exitAt = Date.now();
      resolve({ code, signal });
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      buf += String(chunk);
      for (const line of buf.split("\n")) {
        if (line === "TERM" && termAt === null) termAt = Date.now();
        const m = /^PORT (\d+)$/.exec(line);
        if (m) resolve(Number(m[1]));
      }
      buf = buf.endsWith("\n") ? "" : buf.slice(buf.lastIndexOf("\n") + 1);
    });
    child.on("error", reject);
  });
  if (child.pid === undefined) throw new Error("stub spawned without a pid");
  return {
    child,
    pid: child.pid,
    port,
    token,
    termReceivedAt: () => termAt,
    exitedAt: () => exitAt,
    exit: () => exited,
  };
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const portOpen = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const s = connect({ host: "127.0.0.1", port });
    s.setTimeout(1000);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("timeout", () => {
      s.destroy();
      resolve(false);
    });
    s.once("error", () => resolve(false));
  });

/** A port nothing listens on right now (bind 0, read it back, release it). */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address();
      if (addr === null || typeof addr === "string") return reject(new Error("no address"));
      s.close(() => resolve(addr.port));
    });
  });

const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Never leave a stub behind, whatever the assertion outcome. */
function reapStub(stub: Stub): void {
  try {
    process.kill(stub.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

const byWhat = (actions: TeardownAction[], what: string): TeardownAction => {
  const a = actions.find((x) => x.what === what);
  if (a === undefined) throw new Error(`no action for ${what} in ${JSON.stringify(actions)}`);
  return a;
};

describe("terminateAndVerify — SIGTERM, wait, SIGKILL", () => {
  test("the B5 reproduction: a listener that ignores SIGTERM stays alive holding its port; the escalation SIGKILLs it and the port is released", async () => {
    const stub = await spawnStub("rbtest-r8-stubborn", { ignoreSigterm: true, listen: true });
    try {
      // Step 1 — the defect, reproduced: one SIGTERM, delivered, ignored.
      process.kill(stub.pid, "SIGTERM");
      await sleepMs(300);
      assert.ok(stub.termReceivedAt() !== null, "the stub must have RECEIVED the SIGTERM (not merely survived it)");
      assert.equal(pidAlive(stub.pid), true, "still alive after SIGTERM — this is the x11vnc B5 measured");
      assert.equal(await portOpen(stub.port), true, "and still holding its port");

      // Step 2 — the fix: wait a bounded grace, then SIGKILL, then confirm.
      const started = Date.now();
      const action = await rb.terminateAndVerify(stub.pid, stub.token, "x11vnc", { graceMs: 500 });
      const took = Date.now() - started;
      assert.equal(action.result, "killed", JSON.stringify(action));
      assert.match(action.detail ?? "", /ignored SIGTERM for 500 ms; SIGKILL ended it after \d+ ms/);
      assert.ok(took >= 500 && took < 3000, `escalated after the grace, not before or much after: ${took} ms`);
      const { signal } = await stub.exit();
      assert.equal(signal, "SIGKILL", "the process died to SIGKILL, not on its own");
      assert.equal(pidAlive(stub.pid), false);
      assert.equal(await portOpen(stub.port), false, "the port is released");
      const verdict = await rb.verifyPortReleased(stub.port, "VNC port");
      assert.equal(verdict.result, "port-free", JSON.stringify(verdict));
    } finally {
      reapStub(stub);
    }
  });

  test("a cooperative process exits on SIGTERM and is never SIGKILLed", async () => {
    const stub = await spawnStub("rbtest-r8-cooperative", { ignoreSigterm: false, listen: true });
    try {
      const action = await rb.terminateAndVerify(stub.pid, stub.token, "websockify", { graceMs: 2000 });
      assert.equal(action.result, "terminated", JSON.stringify(action));
      assert.ok((action.exited_after_ms ?? Infinity) < 2000, "did not wait the whole grace for a process that left at once");
      const { code, signal } = await stub.exit();
      assert.equal(signal, null, "no SIGKILL was sent");
      assert.equal(code, 0, "the stub's own SIGTERM handler exited it");
      assert.equal(await portOpen(stub.port), false);
    } finally {
      reapStub(stub);
    }
  });

  test("a pid whose cmdline lacks the recorded token is never signalled — pid reuse is the risk", async () => {
    const stub = await spawnStub("rbtest-r8-someone-else", { ignoreSigterm: false, listen: false });
    try {
      const action = await rb.terminateAndVerify(stub.pid, "rbtest-r8-the-token-we-recorded", "x11vnc", { graceMs: 200 });
      assert.equal(action.result, "skipped-pid-reuse", JSON.stringify(action));
      await sleepMs(150);
      assert.equal(stub.termReceivedAt(), null, "no SIGTERM reached it");
      assert.equal(pidAlive(stub.pid), true);
    } finally {
      reapStub(stub);
    }
  });

  test("the grace windows are the documented literals and fit inside Done's 15 s port assertion", () => {
    // Literals on purpose: a fixture derived from the constants would move with a bug in them.
    assert.equal(rb.TERMINATE_GRACE_MS, 3_000);
    assert.equal(rb.KILL_GRACE_MS, 1_000);
    assert.equal(rb.PORT_RELEASE_TIMEOUT_MS, 3_000);
    // Worst case for one stack: clients overlap (one grace + one kill grace), then Xvfb (the
    // same again), then two port checks. B5's check waits 15 s after Done for both ports, and
    // endSession() gives `close` 30 s, of which up to 20 s is spent waiting on the supervisor.
    assert.ok(2 * (3_000 + 1_000) + 2 * 3_000 <= 15_000);
  });
});

describe("teardownStack — the whole recorded stack, verified by its ports", () => {
  test("a stubborn x11vnc plus a pid the token guard refuses: x11vnc is killed, Xvfb waits for it, the refused pid's held port makes the verdict incomplete", async () => {
    const displayNum = 977;
    // websockify's recorded token is String(novncPort). This stub deliberately does NOT carry
    // it on its cmdline — the pid-reuse guard must refuse to signal it, and the port check
    // must then report the port it still holds. That is the honest outcome for a pid that
    // no longer looks like what was recorded.
    const websockify = await spawnStub("rbtest-r8-ws-no-token", { ignoreSigterm: false, listen: true });
    const x11vnc = await spawnStub(`:${displayNum}`, { ignoreSigterm: true, listen: true });
    const xvfb = await spawnStub(`:${displayNum}`, { ignoreSigterm: false, listen: false });
    try {
      const state: TakeoverStateRecord = {
        displayNum,
        vncPort: x11vnc.port,
        novncPort: websockify.port,
        xvfb: { pid: xvfb.pid },
        wm: null,
        autocutsel_clipboard: null,
        autocutsel_primary: null,
        x11vnc: { pid: x11vnc.pid },
        websockify: { pid: websockify.pid },
      };
      const started = Date.now();
      const result = await rb.teardownStack(state, { graceMs: 500, portTimeoutMs: 1_000 });
      const { actions } = result;
      assert.deepEqual(
        actions.map((a) => a.what),
        ["websockify", "x11vnc", "autocutsel-primary", "autocutsel-clipboard", "window manager", "Xvfb", "VNC port", "noVNC port"],
        "clients first, then the X server, then the proof",
      );
      assert.equal(byWhat(actions, "websockify").result, "skipped-pid-reuse");
      assert.equal(byWhat(actions, "x11vnc").result, "killed", JSON.stringify(byWhat(actions, "x11vnc")));
      assert.equal(byWhat(actions, "Xvfb").result, "terminated");
      assert.equal(byWhat(actions, "VNC port").result, "port-free");
      // The websockify stub is still alive (refused), so its port is still held — and the
      // verdict must say so rather than call the teardown complete.
      assert.equal(byWhat(actions, "noVNC port").result, "port-still-held");
      assert.equal(byWhat(actions, "noVNC port").pid, websockify.pid, "the holder is named by pid");
      assert.equal(result.complete, false);
      assert.equal(pidAlive(websockify.pid), true, "the refused pid was never signalled");

      // Ordering: Xvfb received its SIGTERM only after the stubborn x11vnc was dead. x11vnc
      // ignores SIGTERM for the whole 500 ms grace, so Xvfb's signal cannot arrive before that
      // window has elapsed — the old one-shot teardown signalled it within a millisecond.
      // (The parent's `exit` event is not usable as the reference: it fires a few ms AFTER the
      // child is already a zombie, which is what the teardown's own liveness probe sees.)
      await x11vnc.exit();
      const xvfbTerm = xvfb.termReceivedAt();
      assert.ok(xvfbTerm !== null, "Xvfb received a SIGTERM");
      assert.ok(xvfbTerm - started >= 500, `Xvfb was signalled ${xvfbTerm - started} ms in — before x11vnc's grace could have run out`);
      assert.equal(await portOpen(x11vnc.port), false);
    } finally {
      reapStub(websockify);
      reapStub(x11vnc);
      reapStub(xvfb);
    }
  });

  test("with every recorded pid carrying its token the stack comes down complete and both ports read free", async () => {
    // Spawn websockify LAST so its recorded token — the noVNC port it serves — can be put on
    // its own cmdline, exactly as the real `websockify 127.0.0.1:<port> …` argv carries it.
    const displayNum = 978;
    const x11vnc = await spawnStub(`:${displayNum}`, { ignoreSigterm: true, listen: true });
    const xvfb = await spawnStub(`:${displayNum}`, { ignoreSigterm: false, listen: false });
    const novncPort = await freePort();
    const websockify = await spawnStub(`127.0.0.1:${novncPort}`, { ignoreSigterm: false, listen: false });
    try {
      const result = await rb.teardownStack(
        {
          displayNum,
          vncPort: x11vnc.port,
          novncPort,
          xvfb: { pid: xvfb.pid },
          wm: null,
          autocutsel_clipboard: null,
          autocutsel_primary: null,
          x11vnc: { pid: x11vnc.pid },
          websockify: { pid: websockify.pid },
        },
        { graceMs: 500, portTimeoutMs: 1_000 },
      );
      assert.equal(result.complete, true, JSON.stringify(result.actions));
      assert.equal(byWhat(result.actions, "websockify").result, "terminated");
      assert.equal(byWhat(result.actions, "x11vnc").result, "killed");
      assert.equal(byWhat(result.actions, "Xvfb").result, "terminated");
      assert.equal(byWhat(result.actions, "VNC port").result, "port-free");
      assert.equal(byWhat(result.actions, "noVNC port").result, "port-free");
      for (const s of [x11vnc, xvfb, websockify]) assert.equal(pidAlive(s.pid), false, `${s.token} is gone`);
    } finally {
      reapStub(x11vnc);
      reapStub(xvfb);
      reapStub(websockify);
    }
  });

  test("a FOREIGN holder of the VNC port is named by pid, never signalled, and makes the teardown incomplete", async () => {
    const foreign = await spawnStub("rbtest-r8-foreign-holder", { ignoreSigterm: false, listen: true });
    try {
      const result = await rb.teardownStack(
        {
          displayNum: 979,
          vncPort: foreign.port,
          novncPort: await freePort(),
          xvfb: null,
          wm: null,
          autocutsel_clipboard: null,
          autocutsel_primary: null,
          x11vnc: null,
          websockify: null,
        },
        { graceMs: 200, portTimeoutMs: 300 },
      );
      const vnc = byWhat(result.actions, "VNC port");
      assert.equal(vnc.result, "port-still-held", JSON.stringify(vnc));
      assert.equal(vnc.pid, foreign.pid);
      assert.match(vnc.detail ?? "", new RegExp(`held 300 ms after teardown by pid ${foreign.pid} \\(node\\)`));
      assert.equal(byWhat(result.actions, "noVNC port").result, "port-free");
      assert.equal(result.complete, false);
      assert.equal(foreign.termReceivedAt(), null, "this tool signals only pids it recorded");
      assert.equal(pidAlive(foreign.pid), true);
    } finally {
      reapStub(foreign);
    }
  });

  test("teardownIsComplete: every 'gone' result passes, every survivor fails it", () => {
    const gone = ["not-running", "terminated", "killed", "skipped-pid-reuse", "no-pid-recorded", "none-was-running", "port-free", "no-port-recorded"];
    assert.equal(rb.teardownIsComplete(gone.map((result) => ({ what: "x", result }))), true);
    for (const result of ["signal-failed", "kill-failed", "survived-sigkill", "port-still-held"]) {
      assert.equal(rb.teardownIsComplete([{ what: "x", result: "terminated" }, { what: "y", result }]), false, result);
    }
    assert.equal(rb.teardownIsComplete([]), true);
  });
});

describe("teardownTakeoverAt — takeover.json survives until the stack is proven gone", () => {
  test("kept while a port is still held; removed once the teardown is complete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "rbtest-r8-"));
    const path = join(dir, "takeover.json");
    // Fix cycle 2: the activity file beside takeover.json carries the cap origin. It must be
    // KEPT while the stack is up (the survivors' session is still real) and RESET once the
    // teardown is proven complete, so the profile's next supervisor starts with a null origin.
    const activityFile = join(dir, "takeover-activity.json");
    const staleActivity = {
      connected: 0,
      connects: 12,
      first_connect_at: "2026-08-26T02:27:43.267Z",
      last_connect_at: "2026-08-26T02:41:16.222Z",
      last_disconnect_at: "2026-08-26T02:41:37.487Z",
      written_at: "2026-08-26T02:41:37.487Z",
    };
    writeFileSync(activityFile, `${JSON.stringify(staleActivity, null, 2)}\n`, { mode: 0o600 });
    const foreign = await spawnStub("rbtest-r8-holder-for-state", { ignoreSigterm: false, listen: true });
    try {
      writeFileSync(
        path,
        JSON.stringify({
          displayNum: 980,
          display: ":980",
          vncPort: foreign.port,
          novncPort: await freePort(),
          xvfb: null,
          wm: null,
          autocutsel_clipboard: null,
          autocutsel_primary: null,
          x11vnc: null,
          websockify: null,
          started_at: "2026-08-26T00:00:00.000Z",
          supervisor_pid: null,
        }),
        { mode: 0o600 },
      );
      const first = await rb.teardownTakeoverAt(path, { graceMs: 200, portTimeoutMs: 300 });
      assert.equal(first.complete, false);
      assert.equal(existsSync(path), true, "the state file must outlive a teardown that did not happen");
      assert.equal(byWhat(first.actions, "VNC port").pid, foreign.pid);
      assert.deepEqual(first.origin, { result: "kept-stack-incomplete" });
      assert.equal(
        (JSON.parse(readFileSync(activityFile, "utf8")) as { first_connect_at: unknown }).first_connect_at,
        staleActivity.first_connect_at,
        "the origin is untouched while the stack is still up",
      );

      reapStub(foreign);
      await foreign.exit();
      const second = await rb.teardownTakeoverAt(path, { graceMs: 200, portTimeoutMs: 300 });
      assert.equal(second.complete, true, JSON.stringify(second.actions));
      assert.equal(existsSync(path), false, "gone only once the ports are proven free");
      assert.deepEqual(second.origin, { result: "reset" });
      const afterReset = JSON.parse(readFileSync(activityFile, "utf8")) as Record<string, unknown>;
      assert.equal(afterReset.first_connect_at, null, "the next supervisor on this profile starts with no origin");
      assert.equal(afterReset.connects, 12, "the cumulative facts survive");

      const third = await rb.teardownTakeoverAt(path);
      assert.deepEqual(
        third,
        { actions: [], complete: true, origin: { result: "already-null" } },
        "no state file: nothing to do, and that is complete; the origin needs no second rewrite",
      );
    } finally {
      reapStub(foreign);
      if (existsSync(path)) unlinkSync(path);
      unlinkSync(activityFile);
      rmdirSync(dir);
    }
  });
});

describe("resetTakeoverOriginAt — a profile never carries a cap origin into its next life", () => {
  const NOW = Date.parse("2026-08-26T03:00:44.250Z");
  const stale = {
    connected: 1,
    connects: 7,
    first_connect_at: "2026-08-25T22:30:44.000Z",
    last_connect_at: "2026-08-26T02:41:16.222Z",
    last_disconnect_at: "2026-08-26T02:41:37.487Z",
    written_at: "2026-08-26T02:41:37.487Z",
  };

  test("a stale origin is nulled, connected reads 0, connects and the last_* facts survive — and forge-control's strict reader accepts the result", async () => {
    // Laid out as <stateRoot>/<profile>/takeover-activity.json so readActivity() — the reader
    // that THROWS on a malformed field and would refuse the next socket with 503 — can be run
    // against exactly the bytes the supervisor wrote. That is the contract, not this test's
    // opinion of it.
    const root = mkdtempSync(join(tmpdir(), "rbtest-origin-"));
    const profile = "rbtest-origin";
    mkdirSync(join(root, profile), { mode: 0o700 });
    const path = join(root, profile, "takeover-activity.json");
    try {
      writeFileSync(path, `${JSON.stringify(stale, null, 2)}\n`, { mode: 0o600 });
      assert.deepEqual(rb.resetTakeoverOriginAt(path, NOW), { result: "reset" });
      const after = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
      assert.deepEqual(after, {
        connected: 0,
        connects: 7,
        first_connect_at: null,
        last_connect_at: stale.last_connect_at,
        last_disconnect_at: stale.last_disconnect_at,
        written_at: new Date(NOW).toISOString(),
      });
      const parsed = await readActivity(profile, root);
      assert.equal(parsed?.first_connect_at, null);
      assert.equal(parsed?.connects, 7);
      assert.deepEqual(rb.resetTakeoverOriginAt(path, NOW + 1), { result: "already-null" }, "idempotent: nothing to rewrite");
      assert.equal((JSON.parse(readFileSync(path, "utf8")) as { written_at: string }).written_at, new Date(NOW).toISOString(), "and it did not rewrite");
    } finally {
      unlinkSync(path);
      rmdirSync(join(root, profile));
      rmdirSync(root);
    }
  });

  test("absent → absent; garbage → unreadable with the bytes untouched; a non-object → not-an-object. Never a throw, never a silent rewrite", () => {
    const dir = mkdtempSync(join(tmpdir(), "rbtest-origin-"));
    const path = join(dir, "takeover-activity.json");
    try {
      assert.deepEqual(rb.resetTakeoverOriginAt(path, NOW), { result: "absent" });
      writeFileSync(path, "{not json", { mode: 0o600 });
      const garbage = rb.resetTakeoverOriginAt(path, NOW);
      assert.equal(garbage.result, "unreadable");
      assert.match(garbage.detail ?? "", /JSON/);
      assert.equal(readFileSync(path, "utf8"), "{not json", "corrupt state is reported, never silently replaced");
      writeFileSync(path, "[1,2]", { mode: 0o600 });
      assert.equal(rb.resetTakeoverOriginAt(path, NOW).result, "not-an-object");
      assert.equal(readFileSync(path, "utf8"), "[1,2]");
    } finally {
      if (existsSync(path)) unlinkSync(path);
      rmdirSync(dir);
    }
  });
});

/* ========================================================================== *
 * Prerequisite resolution is declared, not guessed
 * ========================================================================== */

describe("prerequisite paths", () => {
  test("playwright is resolved from OUTSIDE this repo — zero repo deps is a hard gate", () => {
    assert.deepEqual(rb.PLAYWRIGHT_CANDIDATE_PATHS, ["/opt/hermes-workspace/node_modules/playwright"]);
    for (const p of rb.PLAYWRIGHT_CANDIDATE_PATHS) {
      assert.ok(!p.startsWith(REPO_ROOT), `${p} must not be inside the repo`);
    }
  });

  test("system Google Chrome is preferred over playwright's revision-pinned chromium", () => {
    const chromeIdx = rb.CHROME_CANDIDATE_PATHS.indexOf("/usr/bin/google-chrome-stable");
    const bundledIdx = rb.CHROME_CANDIDATE_PATHS.findIndex((p) => p.includes("ms-playwright"));
    assert.ok(chromeIdx >= 0, "system Chrome must be a candidate");
    assert.ok(bundledIdx > chromeIdx, "the bundled chromium must be the LAST resort");
  });

  test("findWindowManager picks the first present candidate, in order", () => {
    const present = new Set(["/usr/bin/fluxbox", "/usr/bin/i3"]);
    assert.equal(rb.findWindowManager(rb.WM_CANDIDATE_PATHS, (p) => present.has(p)), "/usr/bin/fluxbox");
    assert.equal(
      rb.findWindowManager(rb.WM_CANDIDATE_PATHS, (p) => p === "/usr/bin/openbox"),
      "/usr/bin/openbox",
    );
  });

  test("a box with NO window manager gets null, not a crash — the WM is optional", () => {
    assert.equal(rb.findWindowManager(rb.WM_CANDIDATE_PATHS, () => false), null);
    assert.equal(rb.findWindowManager([], () => true), null);
  });
});

/* ========================================================================== *
 * aios-takeover-usable B3 — one durable profile, throwaways only on request
 *
 * The defect: every agent run invented a new profile name, and Konrad's hand-typed logins
 * landed in directories nothing reopened. resolveProfileChoice() is the whole gate.
 * ========================================================================== */

describe("resolveProfileChoice", () => {
  const base = { defaultProfile: "konrad-main", serviceKeys: ["perplexity", "generic"] };

  test("omitted → the durable default, accepted even before it exists on disk", () => {
    const c = rb.resolveProfileChoice({ ...base, requested: null, exists: false, throwaway: false });
    assert.deepEqual(c, { profile: "konrad-main", refusal: null, throwaway: false, create: true });
    const later = rb.resolveProfileChoice({ ...base, requested: null, exists: true, throwaway: false });
    assert.equal(later.create, false);
    assert.equal(later.refusal, null);
  });

  test("the default named explicitly behaves exactly like omitting it", () => {
    const a = rb.resolveProfileChoice({ ...base, requested: "konrad-main", exists: false, throwaway: false });
    const b = rb.resolveProfileChoice({ ...base, requested: null, exists: false, throwaway: false });
    assert.deepEqual(a, b);
  });

  test("an existing profile is always accepted — nothing Konrad already has is cut off", () => {
    for (const name of ["os-ui", "r3-takeover", "smoke-r701", "scratch"]) {
      const c = rb.resolveProfileChoice({ ...base, requested: name, exists: true, throwaway: false });
      assert.equal(c.refusal, null, name);
      assert.equal(c.profile, name);
      assert.equal(c.create, false);
      assert.equal(c.throwaway, false, "unmarked and not asked for: durable");
    }
  });

  test("an existing profile that carries the marker reports throwaway without the flag", () => {
    const c = rb.resolveProfileChoice({ ...base, requested: "r5proof", exists: true, marked: true, throwaway: false });
    assert.equal(c.refusal, null);
    assert.equal(c.throwaway, true);
  });

  test("--throwaway on an existing unmarked profile adopts it as disposable (explicit ask, no deletion)", () => {
    const c = rb.resolveProfileChoice({ ...base, requested: "scratch", exists: true, throwaway: true });
    assert.equal(c.refusal, null);
    assert.equal(c.throwaway, true);
    assert.equal(c.create, false);
  });

  test("a SERVICES key may be created without --throwaway — a service profile is durable by design", () => {
    const c = rb.resolveProfileChoice({ ...base, requested: "perplexity", exists: false, throwaway: false });
    assert.deepEqual(c, { profile: "perplexity", refusal: null, throwaway: false, create: true });
  });

  test("any other NEW name without --throwaway is refused with the two ways out", () => {
    const c = rb.resolveProfileChoice({ ...base, requested: "r706-proof", exists: false, throwaway: false });
    assert.equal(c.profile, "r706-proof");
    assert.equal(c.create, false);
    assert.equal(
      c.refusal,
      'profile "r706-proof" does not exist — pass --throwaway to create a disposable one, or omit the profile to use konrad-main',
    );
  });

  test("a NEW name WITH --throwaway is created and marked", () => {
    const c = rb.resolveProfileChoice({ ...base, requested: "r706-proof", exists: false, throwaway: true });
    assert.deepEqual(c, { profile: "r706-proof", refusal: null, throwaway: true, create: true });
  });

  test("the default can never be a throwaway, omitted or named, existing or not", () => {
    for (const requested of [null, "konrad-main"]) {
      for (const exists of [false, true]) {
        const c = rb.resolveProfileChoice({ ...base, requested, exists, throwaway: true });
        assert.match(c.refusal ?? "", /is the durable default and cannot be a throwaway/, `${requested} exists=${exists}`);
        assert.equal(c.create, false);
      }
    }
  });

  test("the refusal names the CONFIGURED default, not a literal", () => {
    const c = rb.resolveProfileChoice({ ...base, defaultProfile: "team-shared", requested: "x1", exists: false, throwaway: false });
    assert.match(c.refusal ?? "", /omit the profile to use team-shared$/);
  });

  test("the marker lives inside the Chrome user-data-dir, where Chrome ignores it", () => {
    assert.equal(rb.throwawayMarkerPath("r706-proof"), "/opt/ai-os/browser-profiles/r706-proof/.throwaway");
  });
});

/* ========================================================================== *
 * aios-takeover-usable B3 — supervisor-owned takeover clocks
 *
 * forge-control writes socket FACTS to takeover-activity.json; the supervisor turns them into
 * deadlines every tick. The rules under test are the ones Konrad hit: a session must not die
 * while he is connected, must survive him stepping away, and must still have a hard cap.
 * ========================================================================== */

describe("computeTakeoverDeadlines", () => {
  const MIN = 60_000;
  const config = { idleGraceMs: 30 * MIN, takeoverMaxMs: 120 * MIN };
  const T0 = Date.parse("2026-08-26T01:00:00.000Z");
  const iso = (ms: number) => new Date(ms).toISOString();
  const activity = (over: TakeoverActivity = {}): TakeoverActivity => ({
    connected: 1,
    connects: 1,
    first_connect_at: iso(T0),
    last_connect_at: iso(T0),
    last_disconnect_at: null,
    written_at: iso(T0),
    ...over,
  });

  test("no activity file (nobody ever connected) changes nothing — the agent-only clocks govern", () => {
    const c = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: T0, activity: null, idleDeadline: T0 + 60 * MIN, hardDeadline: T0 + 480 * MIN, config });
    assert.deepEqual(c, {
      idleDeadline: T0 + 60 * MIN,
      takeoverDeadline: null,
      takeoverStartedAt: null,
      connected: 0,
      shutdownReason: null,
      warnings: [],
    });
  });

  test("a CONNECTED viewer is never idle: the idle deadline is pushed past `now` even when it had expired", () => {
    // The agent's 1 h idle clock ran out 20 min ago; Konrad is in the session. No shutdown.
    const expired = T0 - 20 * MIN;
    const c = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: T0, activity: activity(), idleDeadline: expired, hardDeadline: T0 + 480 * MIN, config });
    assert.equal(c.connected, 1);
    assert.equal(c.idleDeadline, T0 + 30 * MIN, "now + grace, so the loop's `now > idleDeadline` cannot fire");
    assert.equal(c.shutdownReason, null);
    // …and it keeps moving with every tick, never backwards.
    const later = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: T0 + 5 * MIN, activity: activity(), idleDeadline: c.idleDeadline, hardDeadline: T0 + 480 * MIN, config });
    assert.equal(later.idleDeadline, T0 + 35 * MIN);
  });

  test("a later existing idle deadline is kept — max(), never a pull-back", () => {
    const c = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: T0, activity: activity(), idleDeadline: T0 + 240 * MIN, hardDeadline: T0 + 480 * MIN, config });
    assert.equal(c.idleDeadline, T0 + 240 * MIN, "LOGIN_IDLE 4 h outlives a 30 min grace");
  });

  test("after the last disconnect the grace ARMS from last_disconnect_at; the first idle tick does not kill", () => {
    const left = T0 + 10 * MIN;
    const gone = activity({ connected: 0, last_disconnect_at: iso(left) });
    // The tick right after the socket closed: idle deadline was already past, still no shutdown.
    const first = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: left + 1, activity: gone, idleDeadline: T0 - MIN, hardDeadline: T0 + 480 * MIN, config });
    assert.equal(first.connected, 0);
    assert.equal(first.idleDeadline, left + 30 * MIN, "armed: last_disconnect_at + grace");
    assert.equal(first.shutdownReason, null);
    assert.ok(first.idleDeadline > left + 1, "the loop's idle check cannot fire on this tick");
    // 29 min later: still inside the grace.
    const inside = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: left + 29 * MIN, activity: gone, idleDeadline: first.idleDeadline, hardDeadline: T0 + 480 * MIN, config });
    assert.ok(inside.idleDeadline > left + 29 * MIN);
    // 31 min later: the deadline is behind `now` — the LOOP's idle check fires (not this function).
    const after = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: left + 31 * MIN, activity: gone, idleDeadline: first.idleDeadline, hardDeadline: T0 + 480 * MIN, config });
    assert.equal(after.idleDeadline, left + 30 * MIN);
    assert.ok(left + 31 * MIN > after.idleDeadline, "grace elapsed → idle shutdown is due");
    assert.equal(after.shutdownReason, null, "idle is the loop's verdict; only the cap is decided here");
  });

  test("a reconnect within the grace cancels it — connected wins over last_disconnect_at", () => {
    const back = activity({ connected: 1, last_disconnect_at: iso(T0 + 10 * MIN), last_connect_at: iso(T0 + 20 * MIN) });
    const c = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: T0 + 20 * MIN, activity: back, idleDeadline: T0 + 40 * MIN, hardDeadline: T0 + 480 * MIN, config });
    assert.equal(c.idleDeadline, T0 + 50 * MIN, "now + grace, not last_disconnect_at + grace");
  });

  test("the cap counts from first_connect_at and fires only once `now` is past it", () => {
    const before = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: T0 + 119 * MIN, activity: activity(), idleDeadline: T0 + 600 * MIN, hardDeadline: T0 + 480 * MIN, config });
    assert.equal(before.takeoverStartedAt, T0);
    assert.equal(before.takeoverDeadline, T0 + 120 * MIN);
    assert.equal(before.shutdownReason, null);
    const at = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: T0 + 120 * MIN, activity: activity(), idleDeadline: T0 + 600 * MIN, hardDeadline: T0 + 480 * MIN, config });
    assert.equal(at.shutdownReason, null, "the boundary itself is not past");
    const past = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: T0 + 120 * MIN + 1, activity: activity(), idleDeadline: T0 + 600 * MIN, hardDeadline: T0 + 480 * MIN, config });
    assert.equal(past.shutdownReason, "takeover cap 2h");
  });

  /* Fix cycle 2 — the operator ruling: the cap must measure THIS session, never the profile's
   * lifetime. `first_connect_at` is written once by forge-control, preserved by the boot
   * reconcile and (before this fix) cleared by nothing, so a supervisor born hours after a
   * profile's first-ever connect computed a deadline already in the past and shut down on its
   * first tick — "takeover cap 2h" on a session 250 ms old. The fixture below is copied
   * VERBATIM from /opt/ai-os/browser-profiles/.state/rbtest-clock-zz/takeover-activity.json as
   * it sat on disk on 2026-08-26 (the ruling's "WOULD SHUT DOWN IMMEDIATELY" row). The four
   * .state files stay on disk as evidence; this copy is the regression test. */
  const STALE_ORIGIN_FIXTURE = {
    connected: 1,
    connects: 1,
    first_connect_at: "2026-08-25T22:30:44.000Z",
    last_connect_at: "2026-08-25T22:30:44.000Z",
    last_disconnect_at: null,
    written_at: "2026-08-26T01:30:44.000Z",
  };

  test("REGRESSION (ruling): a first_connect_at 4.5 h old read by a supervisor 250 ms old → NO shutdown, a full cap window from the supervisor's start", () => {
    const now = Date.parse("2026-08-26T03:00:44.250Z"); // 4.5 h after the fixture's origin
    const startedAt = now - 250; // the supervisor's first tick after Chrome came up
    const c = rb.computeTakeoverDeadlines({
      now, startedAt, activity: STALE_ORIGIN_FIXTURE, idleDeadline: now + 60 * MIN, hardDeadline: startedAt + 480 * MIN, config,
    });
    assert.equal(c.shutdownReason, null, "a supervisor cannot be responsible for time before it existed");
    assert.equal(c.takeoverStartedAt, startedAt, "origin = max(first_connect_at, startedAt)");
    assert.equal(c.takeoverDeadline, startedAt + 120 * MIN, "the FULL cap window, counted from this supervisor");
    assert.ok((c.takeoverDeadline ?? 0) > now, "the deadline lies ahead of the first tick, not 150 min behind it");
    // Control: the same file read by a supervisor that HAS been alive since before that first
    // connect is genuinely 2.5 h into its own session, and the cap must still fire. Removing
    // the cap would pass the assertions above and fail this one.
    const firstConnect = Date.parse(STALE_ORIGIN_FIXTURE.first_connect_at);
    const old = rb.computeTakeoverDeadlines({
      now, startedAt: firstConnect - MIN, activity: STALE_ORIGIN_FIXTURE, idleDeadline: now + 60 * MIN, hardDeadline: now + 480 * MIN, config,
    });
    assert.equal(old.shutdownReason, "takeover cap 2h");
    assert.equal(old.takeoverStartedAt, firstConnect, "a connect after the supervisor's start stays the origin");
  });

  test("a connect AFTER the supervisor started is the origin — the ordinary session is unchanged by the fix", () => {
    const c = rb.computeTakeoverDeadlines({ now: T0 + MIN, startedAt: T0 - 5 * MIN, activity: activity(), idleDeadline: T0 + 600 * MIN, hardDeadline: T0 + 480 * MIN, config });
    assert.equal(c.takeoverStartedAt, T0);
    assert.equal(c.takeoverDeadline, T0 + 120 * MIN);
    assert.equal(c.shutdownReason, null);
  });

  test("startedAt is REQUIRED — a caller that forgets it gets a throw naming the field, not a silent lifetime cap", () => {
    for (const bad of [undefined, null, Number.NaN, Number.POSITIVE_INFINITY, "2026-08-26T01:00:00.000Z"]) {
      assert.throws(
        () => rb.computeTakeoverDeadlines({ now: T0, startedAt: bad as unknown as number, activity: activity(), idleDeadline: T0 + 60 * MIN, hardDeadline: T0 + 480 * MIN, config }),
        /startedAt/,
        `startedAt=${String(bad)} must throw`,
      );
    }
  });

  test("the cap fires even while a viewer is connected — it is the safety cap, not an idle rule", () => {
    const c = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: T0 + 121 * MIN, activity: activity({ connected: 2 }), idleDeadline: T0, hardDeadline: T0 + 480 * MIN, config });
    assert.equal(c.connected, 2);
    assert.equal(c.shutdownReason, "takeover cap 2h");
  });

  test("the cap survives reconnects: later connects do not move first_connect_at", () => {
    const re = activity({ connects: 6, last_connect_at: iso(T0 + 110 * MIN) });
    const c = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: T0 + 121 * MIN, activity: re, idleDeadline: T0 + 600 * MIN, hardDeadline: T0 + 480 * MIN, config });
    assert.equal(c.takeoverDeadline, T0 + 120 * MIN);
    assert.equal(c.shutdownReason, "takeover cap 2h");
  });

  test("the hard deadline is the outer bound for every deadline returned", () => {
    const hard = T0 + 60 * MIN;
    const c = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: T0, activity: activity(), idleDeadline: T0 + 600 * MIN, hardDeadline: hard, config });
    assert.equal(c.takeoverDeadline, hard, "min(first_connect + cap, hard)");
    assert.equal(c.idleDeadline, hard, "idle can never be scheduled past the hard cap");
  });

  test("the reason string carries the configured cap, not a literal", () => {
    const c = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: T0 + 31 * MIN, activity: activity(), idleDeadline: T0 + 600 * MIN, hardDeadline: T0 + 480 * MIN, config: { idleGraceMs: 30 * MIN, takeoverMaxMs: 30 * MIN } });
    assert.equal(c.shutdownReason, "takeover cap 0.5h");
  });

  test("garbage fields are ignored AND named — never a throw, never silence", () => {
    const bad = activity({ connected: "two", first_connect_at: "yesterday", last_disconnect_at: 42 });
    const c = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: T0, activity: bad, idleDeadline: T0 + 60 * MIN, hardDeadline: T0 + 480 * MIN, config });
    assert.equal(c.connected, 0);
    assert.equal(c.takeoverDeadline, null);
    assert.equal(c.shutdownReason, null);
    assert.equal(c.idleDeadline, T0 + 60 * MIN);
    assert.equal(c.warnings.length, 3, c.warnings.join("\n"));
    assert.match(c.warnings[0], /connected="two" is not a number/);
    assert.match(c.warnings[1], /last_disconnect_at=42 is not an ISO time/);
    assert.match(c.warnings[2], /first_connect_at="yesterday" is not an ISO time/);
    // A file that is JSON but not an object is one warning and no effect.
    for (const junk of [[1, 2], "connected"]) {
      const j = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: T0, activity: junk, idleDeadline: T0 + 60 * MIN, hardDeadline: T0 + 480 * MIN, config });
      assert.equal(j.idleDeadline, T0 + 60 * MIN);
      assert.equal(j.warnings.length, 1, JSON.stringify(junk));
      assert.match(j.warnings[0], /not an object/);
    }
  });

  test("a negative connected count is clamped to 0 — a decrement bug upstream must not pin the session open", () => {
    const c = rb.computeTakeoverDeadlines({ startedAt: T0 - MIN, now: T0, activity: activity({ connected: -1 }), idleDeadline: T0 - MIN, hardDeadline: T0 + 480 * MIN, config });
    assert.equal(c.connected, 0);
    assert.equal(c.idleDeadline, T0 - MIN, "not connected and never disconnected: nothing to arm");
  });
});

describe("parseTakeoverClockEnv", () => {
  test("defaults are 30 min grace and a 2 h cap, and match the exported constants", () => {
    const c = rb.parseTakeoverClockEnv({});
    assert.deepEqual(c, { idleGraceMs: 30 * 60 * 1000, takeoverMaxMs: 2 * 60 * 60 * 1000 });
    assert.equal(c.idleGraceMs, rb.TAKEOVER_IDLE_GRACE_DEFAULT_MS);
    assert.equal(c.takeoverMaxMs, rb.TAKEOVER_MAX_SESSION_DEFAULT_MS);
    assert.equal(rb.TAKEOVER_IDLE_GRACE_ENV, "TAKEOVER_IDLE_GRACE_MS");
    assert.equal(rb.TAKEOVER_MAX_SESSION_ENV, "TAKEOVER_MAX_SESSION_MS");
  });

  test("the module-level constants reflect THIS process's env (the documented Number(env ?? default) shape)", () => {
    const expectGrace = Number(process.env.TAKEOVER_IDLE_GRACE_MS ?? rb.TAKEOVER_IDLE_GRACE_DEFAULT_MS);
    const expectMax = Number(process.env.TAKEOVER_MAX_SESSION_MS ?? rb.TAKEOVER_MAX_SESSION_DEFAULT_MS);
    assert.equal(rb.TAKEOVER_IDLE_GRACE_MS, expectGrace);
    assert.equal(rb.TAKEOVER_MAX_SESSION_MS, expectMax);
  });

  test("env overrides parse as milliseconds, independently", () => {
    assert.deepEqual(
      rb.parseTakeoverClockEnv({ TAKEOVER_IDLE_GRACE_MS: "600000", TAKEOVER_MAX_SESSION_MS: "10800000" }),
      { idleGraceMs: 600_000, takeoverMaxMs: 10_800_000 },
    );
    assert.equal(rb.parseTakeoverClockEnv({ TAKEOVER_MAX_SESSION_MS: "1e3" }).takeoverMaxMs, 1000);
    assert.equal(rb.parseTakeoverClockEnv({ TAKEOVER_MAX_SESSION_MS: "1e3" }).idleGraceMs, rb.TAKEOVER_IDLE_GRACE_DEFAULT_MS);
  });

  test("an invalid value throws CliError(USAGE) naming the variable and quoting the value", () => {
    for (const [name, value] of [
      ["TAKEOVER_IDLE_GRACE_MS", "abc"],
      ["TAKEOVER_IDLE_GRACE_MS", "0"],
      ["TAKEOVER_MAX_SESSION_MS", "-1"],
      ["TAKEOVER_MAX_SESSION_MS", "Infinity"],
      ["TAKEOVER_MAX_SESSION_MS", ""],
      ["TAKEOVER_MAX_SESSION_MS", "NaN"],
    ]) {
      assert.throws(
        () => rb.parseTakeoverClockEnv({ [name]: value }),
        (e: Error & { code?: number }) =>
          e.name === "CliError" &&
          e.code === rb.EXIT.USAGE &&
          e.message.includes(name) &&
          e.message.includes(JSON.stringify(value)),
        `${name}=${JSON.stringify(value)}`,
      );
    }
  });

  test("the activity file and the shutdown record live in the profile's STATE dir, not the Chrome dir", () => {
    assert.equal(rb.takeoverActivityPath("konrad-main"), "/opt/ai-os/browser-profiles/.state/konrad-main/takeover-activity.json");
    assert.equal(rb.lastShutdownPath("konrad-main"), "/opt/ai-os/browser-profiles/.state/konrad-main/last-shutdown.json");
  });
});
