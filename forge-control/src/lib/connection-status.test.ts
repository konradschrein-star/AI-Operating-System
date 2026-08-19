/**
 * Tests for the persisted connection status.
 *
 * Run: pnpm test   (node --test via tsx, no test framework dependency)
 *
 * The tests that matter most in this file:
 *
 *  - "connected is unreachable without a checked_at" — R57, the invariant this
 *    whole phase exists for. It is asserted exhaustively rather than by
 *    example: every combination of ok × checked_at × age is enumerated and the
 *    only ones permitted to yield "connected" are the fresh, ok:true ones.
 *  - "a record survives a fresh read with no process state" — R48. The old
 *    implementation held the Google verdict in a module-level variable, so the
 *    answer to "is Google connected?" reset to "nobody has ever asked" on every
 *    restart while the credential file still made it look connected.
 *  - "agy runs under env -i" — R52. A test that only passes in an interactive
 *    shell proves nothing about pm2, which does not read .bashrc. This one
 *    FAILS LOUDLY if the binary is missing; it does not skip (N1).
 *  - "no probe result can carry a token to disk" — the write path projects four
 *    named fields instead of spreading its argument.
 */

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { AddressInfo } from "node:net";

import {
  AGY_BIN,
  AGY_PROBE_ARGS,
  DEFAULT_CONNECTION_RECHECK_INTERVAL_MS,
  GITHUB_PAT_SECRET,
  STALE_FACTOR,
  absentConnectionStatus,
  agyBinIsAbsolute,
  agyBinaryPresent,
  agyUltraNarrative,
  buildConnectionStatus,
  classifyAgyProbe,
  connectionRecheckIntervalMs,
  connectionStatusDir,
  formatAge,
  probeGithub,
  readConnectionRecord,
  renderState,
  resolveGithubToken,
  runCommand,
  scrubToken,
  withUpstream,
  writeConnectionRecord,
  type CommandOutcome,
  type ConnectionRecord,
  type RenderedState,
} from "./connection-status.ts";

const MINUTE = 60_000;
const NOW = Date.parse("2026-08-18T20:00:00.000Z");
const INTERVAL = DEFAULT_CONNECTION_RECHECK_INTERVAL_MS; // 900_000 ms = 15 min

function rec(over: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    ok: true,
    identity: "konrad.schrein@gmail.com",
    detail: "Gmail answered HTTP 200.",
    checked_at: new Date(NOW - MINUTE).toISOString(),
    ...over,
  };
}

/* ========================================================================== *
 * R57 — the invariant. No positive state without a checked_at.
 * ========================================================================== */

describe("R57 — no connection renders a positive state without a checked_at", () => {
  test("a null record renders unknown, never connected", () => {
    const s = renderState(null, { now: NOW, intervalMs: INTERVAL });
    assert.equal(s.state, "unknown");
    assert.equal(s.checked_at, null);
    assert.equal(s.identity, null);
    assert.match(s.detail, /[Nn]ever checked/);
  });

  test("checked_at: null renders unknown EVEN WHEN ok is true", () => {
    const s = renderState(rec({ ok: true, checked_at: null }), {
      now: NOW,
      intervalMs: INTERVAL,
    });
    assert.equal(s.state, "unknown");
    assert.equal(s.checked_at, null);
  });

  test("checked_at: null strips the identity — an unverified address is not one to show", () => {
    const s = renderState(rec({ ok: true, checked_at: null }), {
      now: NOW,
      intervalMs: INTERVAL,
    });
    assert.equal(s.identity, null);
    // …but the stored text is preserved so nothing is silently lost.
    assert.match(s.detail, /Gmail answered HTTP 200/);
  });

  test("connected is UNREACHABLE without a fresh checked_at — exhaustive", () => {
    const ages: (number | null)[] = [
      null, // no checked_at at all
      -MINUTE, // in the future
      0,
      MINUTE,
      INTERVAL * STALE_FACTOR - 1,
      INTERVAL * STALE_FACTOR + 1,
      INTERVAL * 100,
    ];
    for (const ok of [true, false]) {
      for (const ageMs of ages) {
        const record = rec({
          ok,
          checked_at: ageMs === null ? null : new Date(NOW - ageMs).toISOString(),
        });
        const s = renderState(record, { now: NOW, intervalMs: INTERVAL });
        const shouldBeConnected =
          ok && ageMs !== null && ageMs >= 0 && ageMs <= INTERVAL * STALE_FACTOR;
        assert.equal(
          s.state === "connected",
          shouldBeConnected,
          `ok=${ok} ageMs=${ageMs} produced ${s.state}`,
        );
        if (s.state !== "connected") {
          assert.equal(
            s.identity,
            null,
            `ok=${ok} ageMs=${ageMs} kept an identity in state ${s.state}`,
          );
        }
        if (s.state === "connected") {
          assert.notEqual(s.checked_at, null, "connected with a null checked_at");
        }
      }
    }
  });

  test("buildConnectionStatus cannot produce connected from a null record", () => {
    const status = buildConnectionStatus(
      "google",
      null,
      { now: NOW, intervalMs: INTERVAL },
      { connected: "c", unknown: "u", broken: "b" },
    );
    assert.equal(status.state, "unknown");
    assert.equal(status.action, "u");
    assert.equal(status.checked_at, null);
  });

  test("absentConnectionStatus hardcodes a null checked_at and a null identity", () => {
    const s = absentConnectionStatus("github", "no token stored", "store one");
    assert.equal(s.state, "absent");
    assert.equal(s.checked_at, null);
    assert.equal(s.identity, null);
  });
});

/* ========================================================================== *
 * R51 — staleness. The status must not age silently into a lie.
 * ========================================================================== */

describe("R51 — a stale result is demoted, not silently believed", () => {
  test("exactly at the boundary is still connected; one millisecond past is not", () => {
    const boundary = INTERVAL * STALE_FACTOR;
    const at = (age: number) =>
      renderState(rec({ checked_at: new Date(NOW - age).toISOString() }), {
        now: NOW,
        intervalMs: INTERVAL,
      }).state;
    assert.equal(at(boundary), "connected");
    assert.equal(at(boundary + 1), "unknown");
  });

  test("the stale detail names the age, so the demotion is explicable", () => {
    const s = renderState(
      rec({ checked_at: new Date(NOW - 4 * INTERVAL).toISOString() }),
      { now: NOW, intervalMs: INTERVAL },
    );
    assert.equal(s.state, "unknown");
    assert.match(s.detail, /Stale/);
    assert.match(s.detail, /last probed 60 minutes ago/); // 4 × 15 min
    assert.match(s.detail, /45 minutes shelf life/); // STALE_FACTOR × interval
    assert.match(s.detail, /2026-08-18T19:00:00\.000Z/);
  });

  test("a stale FAILURE is also demoted — a two-day-old 401 is not current either", () => {
    const s = renderState(
      rec({ ok: false, detail: "HTTP 401 Bad credentials", checked_at: new Date(NOW - 10 * INTERVAL).toISOString() }),
      { now: NOW, intervalMs: INTERVAL },
    );
    assert.equal(s.state, "unknown");
    // The upstream's words survive the demotion.
    assert.match(s.detail, /HTTP 401 Bad credentials/);
  });

  test("a checked_at in the future is not trusted", () => {
    const s = renderState(rec({ checked_at: new Date(NOW + 5 * MINUTE).toISOString() }), {
      now: NOW,
      intervalMs: INTERVAL,
    });
    assert.equal(s.state, "unknown");
    assert.match(s.detail, /clock is wrong/);
  });

  test("an unparseable checked_at throws rather than rendering anything", () => {
    assert.throws(
      () => renderState(rec({ checked_at: "last tuesday" }), { now: NOW, intervalMs: INTERVAL }),
      /not a parseable timestamp/,
    );
  });

  test("a non-positive interval throws — a zero interval would make everything stale", () => {
    assert.throws(
      () => renderState(rec(), { now: NOW, intervalMs: 0 }),
      /positive intervalMs/,
    );
  });

  test("the scheduler and the staleness rule read the same configured number", () => {
    const before = process.env.CONNECTION_RECHECK_INTERVAL_MS;
    try {
      delete process.env.CONNECTION_RECHECK_INTERVAL_MS;
      assert.equal(connectionRecheckIntervalMs(), DEFAULT_CONNECTION_RECHECK_INTERVAL_MS);
      assert.equal(DEFAULT_CONNECTION_RECHECK_INTERVAL_MS, 900_000);
      process.env.CONNECTION_RECHECK_INTERVAL_MS = "60000";
      assert.equal(connectionRecheckIntervalMs(), 60_000);
      process.env.CONNECTION_RECHECK_INTERVAL_MS = "nonsense";
      assert.throws(() => connectionRecheckIntervalMs(), /positive number of milliseconds/);
      process.env.CONNECTION_RECHECK_INTERVAL_MS = "-5";
      assert.throws(() => connectionRecheckIntervalMs(), /positive number of milliseconds/);
    } finally {
      if (before === undefined) delete process.env.CONNECTION_RECHECK_INTERVAL_MS;
      else process.env.CONNECTION_RECHECK_INTERVAL_MS = before;
    }
  });

  test("formatAge picks a unit a human reads at a glance", () => {
    assert.equal(formatAge(30_000), "30s");
    assert.equal(formatAge(10 * MINUTE), "10 minutes");
    assert.equal(formatAge(3 * 3_600_000), "3.0 hours");
    assert.equal(formatAge(5 * 86_400_000), "5.0 days");
  });
});

/* ========================================================================== *
 * R48 — persistence. This is what the module-level variable could not do.
 * ========================================================================== */

describe("R48 — the record survives, because it is on disk and not in a variable", () => {
  let dir = "";
  const envBefore = process.env.FORGE_CONNECTION_STATUS_DIR;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "conn-status-test-"));
    process.env.FORGE_CONNECTION_STATUS_DIR = dir;
  });
  after(async () => {
    if (envBefore === undefined) delete process.env.FORGE_CONNECTION_STATUS_DIR;
    else process.env.FORGE_CONNECTION_STATUS_DIR = envBefore;
    await rm(dir, { recursive: true, force: true });
  });

  test("the env override is honoured, so no test writes near the real store", () => {
    assert.equal(connectionStatusDir(), dir);
    assert.notEqual(connectionStatusDir(), "/opt/ai-os/.secrets/status");
  });

  test("write then read returns the same four fields", async () => {
    const written = rec({ detail: "Gmail answered HTTP 200 as konrad@example.com." });
    await writeConnectionRecord("google", written);
    const back = await readConnectionRecord("google");
    assert.deepEqual(back, written);
  });

  test("a never-written connection reads as null, not as a default", async () => {
    assert.equal(await readConnectionRecord("never-probed"), null);
  });

  test("the file is 0600 — a status record sits beside credentials", async () => {
    await writeConnectionRecord("github", rec({ identity: "konrad" }));
    const s = await stat(join(dir, "github.json"));
    assert.equal(s.mode & 0o777, 0o600);
  });

  test("NO TOKEN CAN REACH DISK — the write projects four named fields", async () => {
    const leaky = {
      ...rec(),
      access_token: "ya29.SUPER-SECRET",
      refresh_token: "1//SECRET",
      client_secret: "GOCSPX-SECRET",
    } as ConnectionRecord;
    await writeConnectionRecord("leaky", leaky);
    const raw = await readFile(join(dir, "leaky.json"), "utf8");
    assert.doesNotMatch(raw, /SUPER-SECRET|1\/\/SECRET|GOCSPX/);
    assert.deepEqual(Object.keys(JSON.parse(raw) as object).sort(), [
      "checked_at",
      "detail",
      "identity",
      "ok",
    ]);
  });

  test("no temp file is left behind — the write is temp + rename", async () => {
    await writeConnectionRecord("agy", rec({ ok: false, identity: null }));
    const { readdir } = await import("node:fs/promises");
    const files = await readdir(dir);
    assert.equal(files.filter((f) => f.includes(".tmp-")).length, 0, files.join(", "));
  });

  test("a CORRUPT record throws — it must not render as 'never checked'", async () => {
    await writeFile(join(dir, "broken-json.json"), "{ not json", { mode: 0o600 });
    await assert.rejects(
      () => readConnectionRecord("broken-json"),
      /is not valid JSON/,
    );
    await writeFile(join(dir, "wrong-shape.json"), JSON.stringify({ ok: "yes" }), {
      mode: 0o600,
    });
    await assert.rejects(
      () => readConnectionRecord("wrong-shape"),
      /no boolean `ok`/,
    );
  });

  test("a traversing id is refused before it touches the filesystem", async () => {
    await assert.rejects(() => readConnectionRecord("../../etc/passwd"), /invalid connection id/);
    await assert.rejects(
      () => writeConnectionRecord("google/../../x" as "google", rec()),
      /invalid connection id/,
    );
  });

  test("R48 IN ONE ASSERTION: a fresh reader with no process state sees the prior checked_at", async () => {
    const checkedAt = "2026-08-18T18:30:00.000Z";
    await writeConnectionRecord("google", rec({ checked_at: checkedAt }));

    // Stand in for "forge-control restarted": nothing in memory, the file is
    // the only carrier. The module-level `lastGoogleCheck` this replaces would
    // have been null here, and the surface would have said "never checked"
    // while the credential file still made the account look connected.
    const back = await readConnectionRecord("google");
    assert.equal(back?.checked_at, checkedAt);
    const status = buildConnectionStatus(
      "google",
      back,
      { now: Date.parse(checkedAt) + MINUTE, intervalMs: INTERVAL },
      { connected: "c", unknown: "u", broken: "b" },
    );
    assert.equal(status.state, "connected");
    assert.equal(status.checked_at, checkedAt);
  });
});

/* ========================================================================== *
 * R52 — agy is addressed absolutely, and it spawns without a PATH.
 * ========================================================================== */

describe("R52 — agy is invoked by absolute path", () => {
  test("AGY_BIN is absolute", () => {
    assert.equal(isAbsolute(AGY_BIN), true, `AGY_BIN=${AGY_BIN} is not absolute`);
    assert.equal(agyBinIsAbsolute(), true);
    assert.equal(AGY_BIN, "/root/.local/bin/agy");
  });

  test("the probe is `models` and never `-p` — `-p` opens a 60s OAuth wait", () => {
    assert.deepEqual([...AGY_PROBE_ARGS], ["models"]);
    assert.equal(AGY_PROBE_ARGS.includes("-p"), false);
    assert.equal(AGY_PROBE_ARGS.includes("--print"), false);
  });

  /**
   * INTEGRATION TEST. Spawns the real binary with `env: {}` — the execFile
   * equivalent of `env -i`, i.e. no PATH, no HOME, nothing. A bare `agy` under
   * these conditions dies with ENOENT, which is exactly what happens under pm2
   * (PATH is exported from .bashrc, which pm2 does not read). This asserts the
   * ABSOLUTE path is what makes the spawn work.
   *
   * If the binary is missing this FAILS. It does not skip: a silently-skipped
   * test reports green for a thing nobody checked (N1).
   */
  test("agy spawns under env -i, proving the absolute path is what carries it", async () => {
    const outcome = await runCommand(AGY_BIN, AGY_PROBE_ARGS, {
      timeoutMs: 20_000,
      env: {},
    });
    assert.equal(
      outcome.errno,
      null,
      `spawning ${AGY_BIN} with an empty environment failed at the OS level (${outcome.errno}) — the absolute-path contract is broken`,
    );
    assert.notEqual(outcome.code, null, "the process never exited normally");
    assert.ok(
      `${outcome.stdout}${outcome.stderr}`.trim().length > 0,
      "the process produced no output at all, so nothing was actually run",
    );
  });

  /**
   * REGRESSION GUARD for the trap this task actually hit. With node's default
   * stdio (fd 0 an open pipe) `agy models` never returns — it is waiting on the
   * "paste the authorization code here" read — so the obvious
   * `execFile(AGY_BIN, ["models"])` blocks until the timeout kills it, on every
   * settings load and every cron tick. runCommand() passes stdin `"ignore"`.
   * Measured: 20038ms/SIGTERM with a pipe, 372ms with /dev/null.
   */
  test("the probe ANSWERS rather than hanging — stdin must be /dev/null", async () => {
    const t0 = Date.now();
    const outcome = await runCommand(AGY_BIN, AGY_PROBE_ARGS, { timeoutMs: 15_000 });
    const elapsed = Date.now() - t0;
    assert.equal(
      outcome.signal,
      null,
      `the probe was killed by ${outcome.signal} after ${elapsed}ms instead of answering — stdin is almost certainly a pipe again`,
    );
    assert.ok(
      elapsed < 5_000,
      `the probe took ${elapsed}ms; S-A measured agy models at 0.32s, so anything near the timeout means it is blocking on stdin`,
    );
    assert.notEqual(outcome.code, null);
  });

  test("a bare `agy` under env -i fails with ENOENT — the control for the test above", async () => {
    const outcome = await runCommand("agy", AGY_PROBE_ARGS, {
      timeoutMs: 10_000,
      env: {},
    });
    assert.equal(
      outcome.errno,
      "ENOENT",
      "a bare `agy` resolved under an empty environment — this test's premise no longer holds",
    );
  });
});

describe("agy probe classification", () => {
  const CHECKED = "2026-08-18T20:00:00.000Z";
  const outcome = (over: Partial<CommandOutcome> = {}): CommandOutcome => ({
    code: 0,
    stdout: "",
    stderr: "",
    errno: null,
    signal: null,
    ...over,
  });

  test("exit 0 with a model list is ok, and the list head is the detail", () => {
    const r = classifyAgyProbe(
      outcome({ stdout: "gemini-3-pro\ngemini-3-flash\n" }),
      CHECKED,
    );
    assert.equal(r.ok, true);
    assert.match(r.detail, /gemini-3-pro/);
    assert.equal(r.checked_at, CHECKED);
  });

  test("identity stays null — `agy models` never names an account", () => {
    assert.equal(classifyAgyProbe(outcome({ stdout: "gemini-3-pro" }), CHECKED).identity, null);
  });

  test("the signed-out answer is a RECORDED failure carrying stderr verbatim (R58)", () => {
    const stderr =
      "Error: Please sign in to view available models. Launch the CLI without arguments to sign in.";
    const r = classifyAgyProbe(outcome({ code: 1, stderr }), CHECKED);
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes(stderr), "stderr was not carried verbatim");
    assert.match(r.detail, /paste-a-code sign-in/);
  });

  test("an UNKNOWN non-zero exit is not reported as a missing login", () => {
    const r = classifyAgyProbe(outcome({ code: 3, stderr: "panic: bad build" }), CHECKED);
    assert.equal(r.ok, false);
    assert.ok(r.detail.includes("panic: bad build"));
    assert.match(r.detail, /CLI fault rather than a missing login/);
  });

  test("ENOENT is reported as a missing binary, not as a missing login", () => {
    const r = classifyAgyProbe(outcome({ code: null, errno: "ENOENT" }), CHECKED);
    assert.equal(r.ok, false);
    assert.match(r.detail, /not installed at that path/);
  });

  test("a timeout kill is not silently an exit code", () => {
    const r = classifyAgyProbe(outcome({ code: null, signal: "SIGTERM" }), CHECKED);
    assert.equal(r.ok, false);
    assert.match(r.detail, /killed by SIGTERM/);
  });

  /* R4-red item 4. The branch used to return ok:true on the exit code alone
   * and then write "(exit 0 but no output)" into the same line as the SIGNED
   * IN chip: one row, two opposite claims, and the green one wins the reader.
   * Exit 0 is not the evidence — the model list is. */
  test("exit 0 with NO stdout is a failure, not a SIGNED IN chip", () => {
    const r = classifyAgyProbe(outcome({ stdout: "", stderr: "" }), CHECKED);
    assert.equal(r.ok, false, "an empty answer was accepted as a live credential");
    assert.match(r.detail, /printed NOTHING on stdout/);
    assert.ok(
      !r.detail.includes("holds a live Google credential"),
      "the success sentence survived into a failure record",
    );
  });

  test("…and whitespace-only stdout counts as no output", () => {
    assert.equal(classifyAgyProbe(outcome({ stdout: "  \n \t\n" }), CHECKED).ok, false);
  });

  test("…while one line of model list is still enough — the rule is not 'exit 0 never counts'", () => {
    assert.equal(classifyAgyProbe(outcome({ stdout: "gemini-3-pro" }), CHECKED).ok, true);
  });

  test("no success detail ever carries the words that used to contradict the chip", () => {
    const r = classifyAgyProbe(outcome({ stdout: "gemini-3-pro" }), CHECKED);
    assert.ok(
      !r.detail.includes("exit 0 but no output"),
      "the placeholder that produced the contradictory row is still reachable",
    );
  });
});

/* ========================================================================== *
 * R4-red fix 1 — the Google AI Ultra row's substrate.
 *
 * `routes/usage.ts` used to walk the forge-control PROCESS's PATH looking for
 * a file called `agy`. pm2 never sources `.bashrc`, where `agy install` puts
 * its export, so the row asserted "agy is not installed on this box" while the
 * binary sat at /root/.local/bin/agy answering probes four inches below it on
 * the same panel. These tests pin the composition that replaced it.
 * ========================================================================== */

describe("the Ultra row's words come from the binary and the probe, never from PATH", () => {
  const fresh = (over: Partial<RenderedState> = {}): RenderedState => ({
    state: "connected",
    identity: null,
    checked_at: "2026-08-18T20:00:00.000Z",
    detail: "agy models exited 0 and listed 7 models.",
    ...over,
  });

  test("not installed: says so, names the path, and offers the install step", () => {
    const n = agyUltraNarrative({ installed: false, probe: null, read_error: null });
    assert.match(n.auth_note, /not installed on this box/);
    assert.ok(n.auth_note.includes(AGY_BIN), "the note does not name the path it checked");
    assert.ok(n.connect_command !== null);
    assert.ok(n.connect_command.includes(AGY_BIN));
  });

  test("installed + a fresh successful probe: no connect command is offered", () => {
    const n = agyUltraNarrative({ installed: true, probe: fresh(), read_error: null });
    assert.equal(n.connect_command, null);
    assert.match(n.auth_note, /is installed and its last probe succeeded/);
    assert.ok(
      !n.auth_note.includes("not installed"),
      "the installed branch still says the CLI is missing",
    );
  });

  test("installed + never probed: NOT a claim that it is missing", () => {
    const n = agyUltraNarrative({
      installed: true,
      probe: fresh({ state: "unknown", checked_at: null, detail: "Never checked." }),
      read_error: null,
    });
    assert.ok(
      !n.auth_note.includes("not installed"),
      "an installed CLI was reported as not installed — the exact defect this replaces",
    );
    assert.match(n.auth_note, /no probe currently vouches/);
    assert.ok(n.connect_command !== null, "the sign-in step disappeared");
  });

  test("installed + a probe that said no: still installed, still a sign-in step", () => {
    const n = agyUltraNarrative({
      installed: true,
      probe: fresh({ state: "broken", detail: "exit 1 — Please sign in to view available models." }),
      read_error: null,
    });
    assert.ok(!n.auth_note.includes("not installed"));
    assert.match(n.auth_note, /Please sign in to view available models/);
  });

  test("the check itself failed: 'we do not know' is not folded into 'no'", () => {
    const n = agyUltraNarrative({
      installed: null,
      probe: null,
      read_error: "could not stat /root/.local/bin/agy: EIO: i/o error",
    });
    assert.ok(
      !n.auth_note.includes("is not installed on this box"),
      "a disk error was rendered as a claim that the CLI is absent",
    );
    assert.match(n.auth_note, /could not be determined/);
    assert.match(n.auth_note, /EIO/);
    assert.equal(n.connect_command, null, "an instruction was printed for a state we cannot read");
  });

  test("installed:true with no rendered probe THROWS rather than defaulting (N1)", () => {
    assert.throws(
      () => agyUltraNarrative({ installed: true, probe: null, read_error: null }),
      /must pass renderState/,
    );
  });

  test("the real box: the binary is where AGY_BIN says, so the row cannot say 'not installed'", async () => {
    // NOT skipped when absent — it fails loudly, exactly like the env -i test
    // above. If `agy` is genuinely gone from this box, that is a finding.
    assert.equal(
      await agyBinaryPresent(),
      true,
      `agyBinaryPresent() says ${AGY_BIN} is absent. Either the CLI was removed, or the substrate check regressed to something that cannot see it.`,
    );
  });
});

/* ========================================================================== *
 * R55, R56, R58 — GitHub, against a local throwaway upstream.
 * ========================================================================== */

describe("R56 — GitHub status comes from a real GET /user", () => {
  let server: Server;
  let base = "";
  let lastAuthHeader: string | null = null;
  let lastUrl = "";
  let mode: "ok" | "fine-grained" | "401" | "500" | "html" | "no-login" = "ok";

  before(async () => {
    server = createServer((req, res) => {
      lastAuthHeader = req.headers.authorization ?? null;
      lastUrl = req.url ?? "";
      if (mode === "401") {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            message: "Bad credentials",
            documentation_url: "https://docs.github.com/rest",
            status: "401",
          }),
        );
        return;
      }
      if (mode === "500") {
        res.writeHead(500, { "content-type": "text/plain" });
        res.end("upstream exploded");
        return;
      }
      if (mode === "html") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html>not json</html>");
        return;
      }
      if (mode === "no-login") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: 1 }));
        return;
      }
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (mode === "ok") headers["x-oauth-scopes"] = "repo, read:org, workflow";
      res.writeHead(200, headers);
      res.end(JSON.stringify({ login: "konradschreiner", id: 4242 }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });

  test("a 200 with a login and scopes is CONNECTED, and names both (R56)", async () => {
    mode = "ok";
    const r = await probeGithub("ghp_TESTTOKEN", { baseUrl: base });
    assert.equal(r.ok, true);
    assert.equal(r.identity, "konradschreiner");
    assert.match(r.detail, /konradschreiner/);
    assert.match(r.detail, /x-oauth-scopes: repo, read:org, workflow/);
    assert.notEqual(r.checked_at, null);
  });

  test("the token travels in an Authorization HEADER, never a URL (R55)", async () => {
    mode = "ok";
    await probeGithub("ghp_TESTTOKEN", { baseUrl: base });
    assert.equal(lastAuthHeader, "Bearer ghp_TESTTOKEN");
    assert.equal(lastUrl, "/user");
    assert.doesNotMatch(lastUrl, /ghp_/);
  });

  test("the token never appears in the record that reaches disk (R55)", async () => {
    mode = "ok";
    const r = await probeGithub("ghp_TESTTOKEN", { baseUrl: base });
    assert.doesNotMatch(JSON.stringify(r), /ghp_TESTTOKEN/);
  });

  test("a fine-grained token's EMPTY scope header is stated, not rendered as 'no permissions'", async () => {
    mode = "fine-grained";
    const r = await probeGithub("github_pat_TEST", { baseUrl: base });
    assert.equal(r.ok, true);
    assert.match(r.detail, /header absent/);
    assert.match(r.detail, /fine-grained/);
  });

  test("a 401 is BROKEN carrying the verbatim status and body (R58)", async () => {
    mode = "401";
    const r = await probeGithub("ghp_DEAD", { baseUrl: base });
    assert.equal(r.ok, false);
    assert.equal(r.identity, null);
    assert.match(r.detail, /UPSTREAM HTTP 401/);
    assert.match(r.detail, /Bad credentials/);
    // The friendly-string failure mode: a generic word with no code.
    assert.doesNotMatch(r.detail, /^Connection failed\.?$/);
  });

  test("a 500 renders differently from a 401 — an outage is not an expired token (R58)", async () => {
    mode = "500";
    const r = await probeGithub("ghp_TESTTOKEN", { baseUrl: base });
    assert.match(r.detail, /UPSTREAM HTTP 500/);
    assert.match(r.detail, /upstream exploded/);
  });

  test("a 200 that is not JSON is UNTESTED, not valid", async () => {
    mode = "html";
    const r = await probeGithub("ghp_TESTTOKEN", { baseUrl: base });
    assert.equal(r.ok, false);
    assert.match(r.detail, /not JSON/);
  });

  test("a 200 with no login is not an identity — token present is not authorisation", async () => {
    mode = "no-login";
    const r = await probeGithub("ghp_TESTTOKEN", { baseUrl: base });
    assert.equal(r.ok, false);
    assert.equal(r.identity, null);
    assert.match(r.detail, /no `login`/);
  });

  test("an unreachable upstream is a failure that says so, not a timeout mislabelled", async () => {
    const r = await probeGithub("ghp_TESTTOKEN", {
      baseUrl: "http://127.0.0.1:1",
      timeoutMs: 2_000,
    });
    assert.equal(r.ok, false);
    assert.match(r.detail, /Could not reach|did not answer/);
  });

  test("scrubToken removes the value from anything quoted back", () => {
    assert.equal(scrubToken("saw ghp_X in the body", "ghp_X"), "saw <redacted> in the body");
    assert.equal(scrubToken("nothing", ""), "nothing");
  });
});

describe("R55 — the PAT is resolved by one canonical name and never guessed", () => {
  test("the canonical name is the one the forge:ui secret block writes", () => {
    assert.equal(GITHUB_PAT_SECRET, "github-pat");
  });

  test("a stored github-pat is used", async () => {
    const resolved = await resolveGithubToken(
      async () => ["github-pat"],
      async (n) => (n === "github-pat" ? "ghp_REAL\n" : null),
    );
    assert.equal(resolved.token, "ghp_REAL");
  });

  test("near-miss names are REPORTED, never silently substituted", async () => {
    const resolved = await resolveGithubToken(
      async () => ["github-pat-konrad", "github-pat-shane", "twenty-api-key"],
      async () => null,
    );
    assert.equal(resolved.token, null);
    assert.deepEqual(
      "candidates" in resolved ? resolved.candidates.sort() : [],
      ["github-pat-konrad", "github-pat-shane"],
    );
  });

  test("an empty stored value is absent, not a token", async () => {
    const resolved = await resolveGithubToken(
      async () => ["github-pat"],
      async () => "   \n",
    );
    assert.equal(resolved.token, null);
  });
});

/* ========================================================================== *
 * R58 — the upstream's own words, always.
 * ========================================================================== */

describe("R58 — verbatim upstream errors", () => {
  test("withUpstream appends the code and the body to the explanation", () => {
    const out = withUpstream("Google refused the refresh token.", 400, '{"error":"invalid_grant"}');
    assert.match(out, /Google refused the refresh token\./);
    assert.match(out, /UPSTREAM HTTP 400/);
    assert.match(out, /invalid_grant/);
  });

  test("with no upstream at all, nothing is invented", () => {
    assert.equal(withUpstream("could not resolve host", null, null), "could not resolve host");
  });

  test("a status with no body still names the code", () => {
    assert.match(withUpstream("refused", 503, null), /UPSTREAM HTTP 503: \(no body\)/);
  });
});
