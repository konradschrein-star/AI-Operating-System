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
import { spawnSync } from "node:child_process";

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
  help: boolean;
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
  writeBrowserStateMarker(input: {
    runId: string;
    profile: string;
    service: string;
    novncPort: number;
  }): { written: boolean; reason?: string; path?: string };
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
  PLAYWRIGHT_CANDIDATE_PATHS: string[];
  CHROME_CANDIDATE_PATHS: string[];
  WM_CANDIDATE_PATHS: string[];
  findWindowManager(paths?: string[], exists?: (p: string) => boolean): string | null;
}

const rb = (await import(SCRIPT_URL)) as ResearchBrowser;

/** The uploads route's own gate, copied here so the test asserts against the real constraint
 *  rather than against the script's opinion of it (forge-control/src/routes/uploads.ts). */
const UPLOADS_ROUTE_ID_RE = /^[a-f0-9]{12}$/;

function run(args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    // A usage error must never reach the network or a browser. Poisoning both resolution
    // paths proves the failure happens before either is consulted.
    env: {
      ...process.env,
      PLAYWRIGHT_MODULE: "/nonexistent/playwright",
      RESEARCH_BROWSER_CHROME: "/nonexistent/chrome",
    },
  });
  if (res.error) throw res.error;
  return { status: res.status ?? -1, stdout: res.stdout, stderr: res.stderr };
}

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
      assert.match(stdout, new RegExp(`^  ${sub} <profile>`, "m"), `${sub} missing from --help`);
    }
    for (const code of [0, 1, 2, 3, 4]) {
      assert.match(stdout, new RegExp(`^  ${code}  `, "m"), `exit ${code} missing from --help`);
    }
    assert.match(stdout, /NO PASSWORD IS EVER STORED/);
    assert.match(stdout, /127\.0\.0\.1 only|never (be )?expos/i);
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

  test("a missing <profile> is a usage error for every subcommand", () => {
    for (const sub of rb.SUBCOMMANDS) {
      const r = run([sub]);
      assert.equal(r.status, rb.EXIT.USAGE, `${sub}: ${r.stderr}`);
      assert.match(r.stderr, new RegExp(`"${sub}" requires a <profile>`));
    }
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
    const r = run(["open", "p", "--service", "notaservice"]);
    assert.equal(r.status, rb.EXIT.USAGE);
    assert.match(r.stderr, /unknown --service "notaservice"/);
    assert.match(r.stderr, /perplexity/);
  });

  test("'generic' with no --url is a usage error, not a crash", () => {
    // No SERVICES entry matches "scratch", so the fallback is generic, which has no home.
    const r = run(["open", "scratch"]);
    assert.equal(r.status, rb.EXIT.USAGE, r.stderr);
    assert.match(r.stderr, /--url is required/);
    assert.match(r.stderr, /fell back to\s+"generic"/);
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
    assert.throws(
      () => rb.parseArgs(["status", "p", "--probe=1"]),
      (e: Error & { code?: number }) => e.name === "CliError" && e.code === rb.EXIT.USAGE,
    );
  });

  test("flags may precede the positional arguments", () => {
    const opts = rb.parseArgs(["--run-id", "abcabcabcabc", "takeover", "perplexity"]);
    assert.equal(opts.subcommand, "takeover");
    assert.equal(opts.profile, "perplexity");
    assert.equal(opts.runId, "abcabcabcabc");
  });

  test("usage failures carry EXIT.USAGE, never a bare Error", () => {
    for (const argv of [[], ["nope", "p"], ["open"], ["open", "BAD NAME"], ["open", "p", "--zzz"]]) {
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
