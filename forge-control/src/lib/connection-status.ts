/**
 * Connection status — the persisted answer to two questions that must never be
 * confused: "does this integration work?" and "when did anyone last ask?"
 *
 * WHY THIS MODULE EXISTS, AND WHAT IT REPLACES.
 *
 * `routes/integrations.ts` used to hold the Google check in a module-level
 * variable (`let lastGoogleCheck`), whose own comment argued the in-memory
 * choice was deliberate: "Survives no restart on purpose: a stale 'connected'
 * from before a revocation is exactly the fake success state this panel must
 * not show." That argument is wrong, and it is wrong in the direction that
 * costs the operator the most.
 *
 * A variable that dies on `pm2 restart forge-control` does not degrade to "we
 * do not know". It degrades to "nobody has ever asked" — while the credential
 * file is still sitting on disk looking exactly like a connected account. So
 * after every single deploy, the surface could not distinguish CONNECTED from
 * NEVER CHECKED, which is the one failure Konrad named as worse than showing
 * nothing at all. The staleness the old comment feared is real, but the answer
 * to a stale result is to STORE IT WITH ITS AGE AND DEMOTE IT WHEN IT ROTS
 * (renderState below, R51), not to throw it away and re-enter total ignorance
 * on every restart.
 *
 * WHERE IT IS STORED. A sidecar JSON file per integration, beside the secret
 * store, mode 0600, written temp+rename so a crash mid-write cannot leave a
 * truncated record. No migration, no new table — `02-architecture.md` §8 rules
 * both out for this project, and four rows do not justify a schema change on a
 * live single-operator system.
 *
 * WHAT IS NEVER STORED. The record is exactly {ok, identity, detail,
 * checked_at}. No access token, no refresh token, no client secret, no PAT.
 * `writeConnectionRecord` projects the four fields explicitly rather than
 * spreading its argument, so a caller that hands over a probe result with a
 * token hanging off it cannot accidentally persist one.
 *
 * THE INVARIANT (R57). `renderState` is the only function in this codebase
 * that may emit "connected", and it cannot do so without a parseable
 * `checked_at` that is younger than STALE_FACTOR × the re-check interval.
 * `checked_at: null` renders UNKNOWN. Always.
 *
 * WHERE "absent" COMES FROM. `renderState` never produces it. "absent" means
 * the SUBSTRATE is missing — no credential file, no stored PAT, no installed
 * binary — which is decidable without probing anything, and is produced only
 * by `absentConnectionStatus()`. A probe that actually ran and came back "not
 * signed in" is NOT absent: we asked and were told no, so it is `ok:false` and
 * renders BROKEN, carrying the upstream's own words. One rule, three
 * integrations, one place to check it.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants as FS } from "node:fs";
import { access, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

/* ── The shape B4c renders ───────────────────────────────────────────────── */

export type ConnectionState = "connected" | "unknown" | "broken" | "absent";

export interface ConnectionStatus {
  id: string;
  state: ConnectionState;
  /** The email/login the PROBE RESPONSE returned — never configuration.
   *  Non-null ONLY when `state === "connected"`: an identity displayed beside
   *  any other state reads as a verified account and is the same lie in a
   *  smaller font. The last-known identity is preserved in `detail` instead. */
  identity: string | null;
  /** ISO-8601, or null when nothing has ever probed. Null ⇒ state is UNKNOWN. */
  checked_at: string | null;
  /** The verbatim upstream answer on failure — status code and body (R58).
   *  Never a friendly string standing in for one: Konrad has to be able to
   *  tell an expired token from a network outage. */
  detail: string;
  /** The exact next step, in the imperative. */
  action: string;
}

/** What lands on disk. Four fields, and nothing else, ever. */
export interface ConnectionRecord {
  ok: boolean;
  identity: string | null;
  detail: string;
  /** ISO-8601. Writers always supply one; the type permits null so a fixture
   *  can exercise the R57 invariant without hand-editing a file. */
  checked_at: string | null;
}

/* ── Configuration ───────────────────────────────────────────────────────── */

/** Default re-check cadence, 15 minutes. Named here rather than in cron-tick
 *  so that the scheduler and `renderState`'s staleness rule read the same
 *  number — a status that is re-checked every 15 minutes but only demoted
 *  after an hour of some other constant is a lie with extra steps. */
export const DEFAULT_CONNECTION_RECHECK_INTERVAL_MS = 900_000;

/**
 * Read per call, not once at import, for the same reason `usage.ts` resolves
 * `agySettingsPath()` per call: a value frozen at module load reports the
 * configuration of process start, and tests must be able to set the env after
 * importing the module they are testing.
 */
export function connectionRecheckIntervalMs(): number {
  const raw = process.env.CONNECTION_RECHECK_INTERVAL_MS;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_CONNECTION_RECHECK_INTERVAL_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `CONNECTION_RECHECK_INTERVAL_MS must be a positive number of milliseconds, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}

/** How many re-check intervals a result may age before it stops counting as
 *  evidence. Three, so a single missed tick (or a restart landing between two)
 *  does not flap every connection to UNKNOWN. */
export const STALE_FACTOR = 3;

/**
 * Where the sidecar records live. The env override is mandatory rather than
 * decorative: every test in this package writes to a tmpdir through it and
 * must never come near `/opt/ai-os/.secrets/status`.
 */
export function connectionStatusDir(): string {
  return process.env.FORGE_CONNECTION_STATUS_DIR ?? "/opt/ai-os/.secrets/status";
}

/** Same rule as `secret-store.ts`: ids are filenames, so keep them boring. */
const ID_RE = /^[a-z0-9][a-z0-9._-]{1,62}$/;

export function isValidConnectionId(id: string): boolean {
  return ID_RE.test(id);
}

/** Belt and braces, exactly as `secret-store.ts#pathFor`: ID_RE already
 *  forbids slashes, and `resolve()` + a prefix check makes traversal
 *  impossible even if that regex is ever loosened. */
function pathFor(id: string): string {
  if (!isValidConnectionId(id)) {
    throw new Error(
      `invalid connection id ${JSON.stringify(id)} — must be lowercase letters, digits, dot, dash or underscore`,
    );
  }
  const dir = connectionStatusDir();
  const abs = resolve(dir, `${id}.json`);
  if (!abs.startsWith(resolve(dir) + "/")) {
    throw new Error(`invalid connection id ${JSON.stringify(id)}`);
  }
  return abs;
}

/* ── Persistence ─────────────────────────────────────────────────────────── */

/**
 * Write the record atomically: a temp file in the same directory, then
 * `rename()`, which is atomic on the same filesystem. A crash mid-write leaves
 * either the previous record or the new one, never half a JSON document that
 * would make every subsequent read throw.
 */
export async function writeConnectionRecord(
  id: string,
  record: ConnectionRecord,
): Promise<ConnectionRecord> {
  const p = pathFor(id);
  await mkdir(connectionStatusDir(), { recursive: true, mode: 0o700 });

  // EXPLICIT PROJECTION, NOT A SPREAD. A probe result may legitimately carry
  // an access token in the caller's local variable; this is the wall that
  // stops one reaching disk. Adding a field here is a deliberate act.
  const stored: ConnectionRecord = {
    ok: record.ok === true,
    identity: record.identity === null ? null : String(record.identity),
    detail: String(record.detail),
    checked_at: record.checked_at === null ? null : String(record.checked_at),
  };

  const tmp = `${p}.tmp-${process.pid}-${randomUUID()}`;
  await writeFile(tmp, `${JSON.stringify(stored, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(tmp, p);
  } catch (err) {
    // Cleanup on an already-failing path; the real error is rethrown below, so
    // nothing is swallowed and no default is returned (N1).
    await unlink(tmp).catch(() => {});
    throw new Error(
      `could not commit the connection status record for ${id} to ${p}: ${(err as Error).message}`,
    );
  }
  return stored;
}

/**
 * Read a record back. `null` means the file does not exist — genuinely nobody
 * has ever probed — which is a legitimate state and not an error. Anything
 * else (unreadable, malformed, wrong shape) THROWS with the path in the
 * message: a corrupt store must not quietly render as "never checked", because
 * those two produce identical amber dots for entirely different reasons.
 */
export async function readConnectionRecord(
  id: string,
): Promise<ConnectionRecord | null> {
  const p = pathFor(id);
  let raw: string;
  try {
    raw = await readFile(p, "utf8");
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return null;
    throw new Error(`could not read the connection status record at ${p}: ${e.message}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `the connection status record at ${p} is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`the connection status record at ${p} is not a JSON object`);
  }

  const o = parsed as Record<string, unknown>;
  if (typeof o.ok !== "boolean") {
    throw new Error(`the connection status record at ${p} has no boolean \`ok\``);
  }
  if (typeof o.detail !== "string") {
    throw new Error(`the connection status record at ${p} has no string \`detail\``);
  }
  if (o.identity !== null && typeof o.identity !== "string") {
    throw new Error(
      `the connection status record at ${p} has an \`identity\` that is neither a string nor null`,
    );
  }
  if (o.checked_at !== null && typeof o.checked_at !== "string") {
    throw new Error(
      `the connection status record at ${p} has a \`checked_at\` that is neither an ISO-8601 string nor null`,
    );
  }
  return {
    ok: o.ok,
    identity: o.identity,
    detail: o.detail,
    checked_at: o.checked_at,
  };
}

/* ── The invariant (R57, R51) ────────────────────────────────────────────── */

export interface RenderClock {
  /** Epoch ms. Passed in rather than read from `Date.now()` so this function
   *  is pure and a test can sit a record on either side of the boundary. */
  now: number;
  intervalMs: number;
}

export interface RenderedState {
  state: Exclude<ConnectionState, "absent">;
  identity: string | null;
  checked_at: string | null;
  detail: string;
}

/** "9 minutes", "2.4 hours", "3.1 days" — a duration a human reads at a
 *  glance, in the largest unit that still leaves a number above 1. */
export function formatAge(ms: number): string {
  if (ms < 0) return `${(-ms / 1000).toFixed(0)}s in the future`;
  if (ms < 90_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 5_400_000) return `${(ms / 60_000).toFixed(0)} minutes`;
  if (ms < 172_800_000) return `${(ms / 3_600_000).toFixed(1)} hours`;
  return `${(ms / 86_400_000).toFixed(1)} days`;
}

/**
 * THE function. The only producer of "connected" in this codebase.
 *
 * Rule order matters and is deliberate — each rule can only ever move the
 * verdict in the under-claiming direction:
 *
 *   1. no record at all            → UNKNOWN  (nobody has ever asked)
 *   2. `checked_at` is null        → UNKNOWN  (R57, verbatim)
 *   3. `checked_at` unparseable    → throw    (a corrupt store is not a state)
 *   4. `checked_at` in the future  → UNKNOWN  (a clock we cannot trust)
 *   5. age > STALE_FACTOR×interval → UNKNOWN  (R51 — no silent ageing)
 *   6. ok === true                 → CONNECTED
 *   7. ok === false                → BROKEN
 *
 * On rule 5 applying to failures as well as successes: a probe result is
 * evidence with a shelf life, and a two-day-old 401 is no more current than a
 * two-day-old 200. Note this differs from `account-health.ts#effectiveHealth`,
 * which leaves a stored `broken` alone — there, `broken` is durable operator
 * knowledge about a credential; here it is the outcome of one network call,
 * which is precisely the thing that ages. The failure text is preserved
 * verbatim in `detail` either way, so nothing is lost, only re-labelled.
 */
export function renderState(
  record: ConnectionRecord | null,
  clock: RenderClock,
): RenderedState {
  if (!Number.isFinite(clock.intervalMs) || clock.intervalMs <= 0) {
    throw new Error(
      `renderState needs a positive intervalMs, got ${JSON.stringify(clock.intervalMs)}`,
    );
  }

  if (record === null) {
    return {
      state: "unknown",
      identity: null,
      checked_at: null,
      detail:
        "Never checked — no probe has ever run against this connection, so nothing here is evidence of anything.",
    };
  }

  if (record.checked_at === null) {
    return {
      state: "unknown",
      identity: null,
      checked_at: null,
      detail: `Never checked — the stored record carries no checked_at, so its verdict is not evidence. Last stored text: ${record.detail}`,
    };
  }

  const at = Date.parse(record.checked_at);
  if (Number.isNaN(at)) {
    throw new Error(
      `the stored checked_at ${JSON.stringify(record.checked_at)} is not a parseable timestamp`,
    );
  }

  const ageMs = clock.now - at;
  const staleAfterMs = clock.intervalMs * STALE_FACTOR;

  if (ageMs < 0) {
    return {
      state: "unknown",
      identity: null,
      checked_at: record.checked_at,
      detail: `Checked at ${record.checked_at}, which is ${formatAge(ageMs)} — the record or this box's clock is wrong, so the verdict is not trustworthy. Last stored text: ${record.detail}`,
    };
  }

  if (ageMs > staleAfterMs) {
    return {
      state: "unknown",
      identity: null,
      checked_at: record.checked_at,
      detail: `Stale — last probed ${formatAge(ageMs)} ago (${record.checked_at}), past the ${formatAge(staleAfterMs)} shelf life (${STALE_FACTOR} × the ${formatAge(clock.intervalMs)} re-check interval). The last answer was ${record.ok ? "a success" : "a failure"}: ${record.detail}`,
    };
  }

  if (record.ok) {
    return {
      state: "connected",
      identity: record.identity,
      checked_at: record.checked_at,
      detail: record.detail,
    };
  }

  return {
    state: "broken",
    identity: null,
    checked_at: record.checked_at,
    detail:
      record.identity === null
        ? record.detail
        : `${record.detail}\n\nLast known identity, from an earlier successful probe: ${record.identity}`,
  };
}

/** Assemble the wire shape. `actions` is keyed by state so the next step the
 *  UI prints is written next to the state it belongs to, rather than assembled
 *  by a component that has to re-derive which one applies. */
export function buildConnectionStatus(
  id: string,
  record: ConnectionRecord | null,
  clock: RenderClock,
  actions: Record<Exclude<ConnectionState, "absent">, string>,
): ConnectionStatus {
  const rendered = renderState(record, clock);
  return {
    id,
    state: rendered.state,
    identity: rendered.identity,
    checked_at: rendered.checked_at,
    detail: rendered.detail,
    action: actions[rendered.state],
  };
}

/**
 * The only producer of "absent". Used when the substrate is missing entirely —
 * no credential file, no stored PAT, no installed binary — which is decidable
 * without a probe, and which is a different sentence from "we probed and it
 * failed". `checked_at` and `identity` are hardcoded null: there is nothing to
 * have checked.
 */
export function absentConnectionStatus(
  id: string,
  detail: string,
  action: string,
): ConnectionStatus {
  return { id, state: "absent", identity: null, checked_at: null, detail, action };
}

/** Compose a human sentence with the upstream's own words appended verbatim
 *  (R58). Never call this with an explanation INSTEAD of the raw answer — the
 *  point is that both are present, so an expired token and a network outage
 *  cannot render identically. */
export function withUpstream(
  message: string,
  httpStatus: number | null,
  upstream: string | null,
): string {
  if (httpStatus === null && upstream === null) return message;
  const head = httpStatus === null ? "UPSTREAM" : `UPSTREAM HTTP ${httpStatus}`;
  return `${message}\n\n${head}: ${upstream ?? "(no body)"}`;
}

/* ── agy / Antigravity CLI (R52) ─────────────────────────────────────────── */

/**
 * The one named constant. `/root/.local/bin/agy` is NOT on `PATH` for
 * non-interactive shells: `agy install` appends the export to `.bashrc`,
 * `.profile` and `.bash_profile`, none of which pm2 sources. A bare `agy`
 * spawned from a route dies with ENOENT under pm2 and works perfectly when a
 * human tests it over SSH, which is the worst possible combination. Proven
 * both ways in phase0/S-A-agy-flow.md §3.
 */
export const AGY_BIN = "/root/.local/bin/agy";

/**
 * The probe, per S-A-agy-flow.md §5: `agy models` returns exit 0 with a model
 * list when authenticated and exit 1 with "Please sign in to view available
 * models." when not, in ~0.32s, and — unlike `-p` — it never opens the 60s
 * OAuth wait. NEVER spawn `agy -p` from a route: it blocks for a minute
 * waiting for a human to paste a PKCE authorization code.
 */
export const AGY_PROBE_ARGS: readonly string[] = ["models"];

/** Generous against the observed 0.32s; small enough that a hung CLI cannot
 *  hold a settings request or a cron tick open. */
export const AGY_PROBE_TIMEOUT_MS = 15_000;

export interface CommandOutcome {
  /** Process exit code, or null when the process never exited normally. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** OS-level spawn failure: "ENOENT" when the binary is not there at all.
   *  Null when a process actually ran, whatever it then exited with. */
  errno: string | null;
  /** Set when the timeout killed it. */
  signal: string | null;
}

/** Cap on captured output, so a CLI that decides to print a megabyte of Go
 *  stack traces cannot become a memory incident inside a cron tick. */
const OUTPUT_CAP_BYTES = 1024 * 1024;

/**
 * Run a command and describe what happened, without throwing.
 *
 * STDIN IS `/dev/null`, AND THAT IS THE WHOLE POINT OF THIS FUNCTION.
 *
 * Measured on 2026-08-18 with /tmp/agy-spawn-probe.mjs (transcript in
 * phase4/agy-env-i-proof.md §3): `agy models` answers in 0.32s from a shell,
 * and HANGS FOREVER when spawned with node's default stdio, in which fd 0 is
 * an open pipe nobody ever writes to or closes. Both `execFile` and a bare
 * `spawn` default to that pipe, so the obvious implementation of this probe —
 * `execFile(AGY_BIN, ["models"])` — blocks until its timeout kills it, every
 * single time, under every environment including a fully inherited one:
 *
 *     stdio ["pipe","pipe","pipe"]    → still running at 12000ms, SIGKILLed
 *     stdio ["ignore","pipe","pipe"]  → exit 1 at 372ms, with the real answer
 *
 * The CLI's auth path is "paste the authorization code here and press Enter",
 * so it opens stdin and waits on it. Handing it a pipe that never closes is
 * asking a settings page to hang for the length of the timeout on every load,
 * and a cron tick to do the same every fifteen minutes. `"ignore"` gives it
 * /dev/null, it reads EOF, and it answers.
 *
 * The second distinction this exists for: `execFile` reports "the binary is
 * missing" and "the binary ran and exited 1" through the same `err.code`
 * field, as a string in the first case and a number in the second. Collapsing
 * those two produces exactly the misdiagnosis R52 is about, so they are
 * separate fields here — `errno` and `code`.
 *
 * Resolution is on `close`, not `exit`: `exit` can fire before the last chunk
 * of stdout has been read, which would silently truncate the very output the
 * classification reads.
 */
export async function runCommand(
  bin: string,
  args: readonly string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv },
): Promise<CommandOutcome> {
  return await new Promise<CommandOutcome>((resolveOutcome) => {
    const child = spawn(bin, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      // Explicit, because it matters: the production probe inherits the real
      // environment so `agy` finds $HOME and therefore its token store
      // (S-A §4 — on this box it uses file-based storage under
      // /root/.gemini/antigravity-cli, chosen because an SSH session is
      // detected). Tests pass `{}` to prove the ABSOLUTE PATH is what makes
      // the spawn work, with no PATH to fall back on.
      env: opts.env ?? process.env,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (outcome: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveOutcome(outcome);
    };

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: null, stdout, stderr, errno: null, signal: "SIGKILL" });
    }, opts.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      if (stdout.length < OUTPUT_CAP_BYTES) stdout += d;
    });
    child.stderr.on("data", (d: string) => {
      if (stderr.length < OUTPUT_CAP_BYTES) stderr += d;
    });

    child.on("error", (err) => {
      const e = err as NodeJS.ErrnoException;
      finish({
        code: null,
        stdout,
        stderr,
        errno: e.code ?? "SPAWN_FAILED",
        signal: null,
      });
    });

    child.on("close", (code, signal) => {
      finish({ code, stdout, stderr, errno: null, signal });
    });
  });
}

/** Marker S-A observed verbatim on the unauthenticated path (§5). Matched only
 *  to phrase the explanation; the classification itself keys off the exit code,
 *  so a wording change upstream cannot turn "signed out" into "connected". */
const AGY_SIGNED_OUT_MARKER = "Please sign in";

/**
 * Pure classification of an `agy models` run. The model list head becomes the
 * detail on success; on any failure the CLI's own stderr is carried verbatim,
 * because "agy is unhappy" is not a diagnosis.
 *
 * `identity` is null unless the output actually names one. `agy models` prints
 * a model list and nothing about the signed-in account, so in practice this is
 * always null — inventing an address here would be the configuration-as-truth
 * lie wearing a different hat.
 */
export function classifyAgyProbe(
  outcome: CommandOutcome,
  checkedAt: string,
): ConnectionRecord {
  const stdout = outcome.stdout.trim();
  const stderr = outcome.stderr.trim();

  if (outcome.errno !== null) {
    return {
      ok: false,
      identity: null,
      detail: `Could not spawn ${AGY_BIN} (${outcome.errno}). ${
        outcome.errno === "ENOENT"
          ? "The Antigravity CLI is not installed at that path."
          : "The OS refused the spawn."
      }${stderr ? `\n\nSTDERR: ${stderr}` : ""}`,
      checked_at: checkedAt,
    };
  }

  if (outcome.signal !== null) {
    return {
      ok: false,
      identity: null,
      detail: `${AGY_BIN} ${AGY_PROBE_ARGS.join(" ")} was killed by ${outcome.signal} after ${AGY_PROBE_TIMEOUT_MS}ms without answering.${stderr ? `\n\nSTDERR: ${stderr}` : ""}`,
      checked_at: checkedAt,
    };
  }

  if (outcome.code === 0) {
    // EXIT 0 IS NOT THE EVIDENCE — THE MODEL LIST IS.
    //
    // R4-red's fix cycle: the first version of this branch returned `ok: true`
    // on the exit code alone and then wrote "(exit 0 but no output)" into the
    // very sentence beside the SIGNED IN chip. One row, two contradictory
    // claims, and the green one wins the reader.
    //
    // A silent exit 0 is what a wrapper script, a `--quiet` flag or a future
    // `agy` that prints its list to stderr all produce, and none of those has
    // shown us a credential. The probe asks "list the models this session can
    // reach"; an empty answer is not that list, so it is `ok: false` carrying
    // exactly what we saw. Under-claiming, in the direction every other rule
    // in this module leans.
    if (stdout === "") {
      return {
        ok: false,
        identity: null,
        detail: `${AGY_BIN} ${AGY_PROBE_ARGS.join(" ")} exited 0 but printed NOTHING on stdout, so no model list came back and nothing here is evidence of a live Google credential. An exit code is not an answer.${stderr ? `\n\nSTDERR: ${stderr}` : "\n\nSTDERR: (empty)"}`,
        checked_at: checkedAt,
      };
    }
    const head = stdout.split("\n").slice(0, 8).join("\n");
    return {
      ok: true,
      identity: null,
      detail: `${AGY_BIN} ${AGY_PROBE_ARGS.join(" ")} exited 0 — the CLI holds a live Google credential. Model list head:\n${head}`,
      checked_at: checkedAt,
    };
  }

  const signedOut = stderr.includes(AGY_SIGNED_OUT_MARKER) || stdout.includes(AGY_SIGNED_OUT_MARKER);
  return {
    ok: false,
    identity: null,
    detail: `${AGY_BIN} ${AGY_PROBE_ARGS.join(" ")} exited ${outcome.code}${
      signedOut
        ? " — nobody has completed the paste-a-code sign-in on this box."
        : " — and not with the known signed-out answer, so treat this as a CLI fault rather than a missing login."
    }\n\nSTDERR: ${stderr || "(empty)"}${stdout ? `\nSTDOUT: ${stdout}` : ""}`,
    checked_at: checkedAt,
  };
}

/** Spawn the real CLI and classify it. Records a failure as a failure; never
 *  throws, so a cron tick calling this cannot be taken down by a broken CLI. */
export async function probeAgy(
  opts: { env?: NodeJS.ProcessEnv } = {},
): Promise<ConnectionRecord> {
  const checkedAt = new Date().toISOString();
  const outcome = await runCommand(AGY_BIN, AGY_PROBE_ARGS, {
    timeoutMs: AGY_PROBE_TIMEOUT_MS,
    env: opts.env,
  });
  return classifyAgyProbe(outcome, checkedAt);
}

/**
 * The exact line a human types to sign `agy` in. Lives here, beside `AGY_BIN`,
 * because two modules print it and a sign-in command that names a different
 * path from the one the probe spawns is a wrong instruction with a confident
 * face.
 */
export const AGY_SIGNIN_COMMAND = AGY_BIN;

/**
 * IS THE BINARY THERE — THE ONE SUBSTRATE QUESTION, ASKED ONE WAY.
 *
 * This function exists because there used to be two answers on one panel.
 * `routes/usage.ts` walked `process.env.PATH` looking for a file called `agy`;
 * `routes/integrations.ts` stat'ed the absolute path. pm2 never sources
 * `.bashrc`, so `/root/.local/bin` is not on forge-control's `PATH`, and the
 * two rows on the Connections surface said opposite things about one binary:
 * "agy is not installed on this box" directly above a probe reporting
 * "SIGNED IN · agy models exited 0 and listed 7 models". R4-red photographed
 * exactly that.
 *
 * So the PATH walk is gone and this is the only substrate check. ENOENT and
 * EACCES mean there is nothing here to be connected — ABSENT. Any other errno
 * is this box failing at something it should be able to do, and is rethrown
 * rather than degrading into a state (N1): "not installed" and "the disk is
 * unhappy" are different sentences and must not render as one.
 */
export async function agyBinaryPresent(): Promise<boolean> {
  try {
    await access(AGY_BIN, FS.X_OK);
    return true;
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT" || e.code === "EACCES") return false;
    throw new Error(`could not stat ${AGY_BIN}: ${e.message}`);
  }
}

/** What the Ultra row is told about `agy`. Two measurements, no configuration:
 *  the binary is on disk, and this is what the last probe of it said. */
export interface AgySubstrate {
  /** `agyBinaryPresent()`. Never a PATH walk, never a systemd unit.
   *
   *  NULL IS A THIRD ANSWER AND IT IS LOAD-BEARING. `access()` failing with
   *  something that is not ENOENT/EACCES — EIO, ELOOP, a mount that went away
   *  — means we could not decide. Folding that into `false` would print "the
   *  CLI is not installed" because a disk hiccuped, which is the same species
   *  of confident wrong answer this whole fix cycle is about. */
  installed: boolean | null;
  /** The persisted record put through `renderState` — the ONE function that
   *  may emit "connected". Null ONLY when `installed` is not true, because
   *  there is no point rendering the age of a probe of a binary we cannot
   *  confirm is there. */
  probe: RenderedState | null;
  /** The verbatim failure behind `installed: null`, or behind an unreadable
   *  status record. Null when nothing failed. Never swallowed (N1). */
  read_error: string | null;
}

/** The two sentences the Google AI Ultra row prints. Pure, so every branch is
 *  reachable from a unit test — the row itself is only ever in one of them on
 *  any given box, which is how the PATH bug survived. */
export interface AgyNarrative {
  /** One line, rendered verbatim: what state the sign-in is actually in. */
  auth_note: string;
  /** The exact thing to type. Null only when a probe has confirmed a session —
   *  never merely because a settings file exists on disk. */
  connect_command: string | null;
}

/**
 * Compose the Ultra row's words from what was measured, and nothing else.
 *
 * The rule that used to be broken here: a file at
 * `~/.gemini/antigravity-cli/settings.json` was read as "signed in locally".
 * A settings file is configuration; it is written the first time the CLI runs
 * and it survives a revoked session, a rotated Google password and an
 * uninstall that left the dotfiles behind. Only the probe decides.
 */
export function agyUltraNarrative(s: AgySubstrate): AgyNarrative {
  if (s.installed === null) {
    return {
      auth_note: `Whether the Antigravity CLI is installed could not be determined — checking ${AGY_BIN} failed: ${s.read_error ?? "(no error was recorded, which is itself a bug)"}. This row is reporting that it does not know, which is not the same as "no".`,
      // Deliberately null. We do not know what state this is in, so there is
      // no honest next step to print — an instruction is a claim too.
      connect_command: null,
    };
  }

  if (s.installed === false) {
    return {
      auth_note: `The Antigravity CLI is not installed on this box — nothing is present or executable at ${AGY_BIN}, so the Ultra subscription has never been signed in here.`,
      connect_command: `install the Antigravity CLI so that ${AGY_BIN} exists, then run \`${AGY_SIGNIN_COMMAND}\` once to sign in`,
    };
  }

  if (s.probe === null) {
    throw new Error(
      `agyUltraNarrative was given installed:true with no rendered probe — the caller must pass renderState(record, clock), which handles a missing record itself. A null here would silently become "we do not know" for an installed CLI.`,
    );
  }

  if (s.probe.state === "connected") {
    return {
      auth_note: `${AGY_BIN} is installed and its last probe succeeded: ${s.probe.detail}`,
      connect_command: null,
    };
  }

  return {
    auth_note: `${AGY_BIN} is installed, but no probe currently vouches for the session: ${s.probe.detail}`,
    connect_command: `sign in at a terminal on this box: \`${AGY_SIGNIN_COMMAND}\`, then open the printed Google URL and paste the authorization code back within 60 seconds`,
  };
}

/**
 * Read both measurements. NEVER THROWS, and that is a deliberate boundary
 * decision rather than a swallowed error.
 *
 * The caller is `GET /api/usage/quota`, which also carries the Anthropic
 * windows. `check-gemini-tally.ts` §5 already pins the rule that the two
 * upstreams are independent — an Anthropic 429 must not take the Gemini line
 * down — and the converse holds here: an unreadable `agy` sidecar must not
 * take the Claude quota row down with it. So every failure becomes a FIELD,
 * carried verbatim in `read_error` and printed by `agyUltraNarrative`, rather
 * than a 500. Nothing is defaulted and nothing is hidden; the failure is
 * simply rendered instead of thrown (N1).
 */
export async function readAgySubstrate(nowMs: number = Date.now()): Promise<AgySubstrate> {
  let installed: boolean;
  try {
    installed = await agyBinaryPresent();
  } catch (err) {
    return { installed: null, probe: null, read_error: (err as Error).message };
  }
  if (!installed) return { installed: false, probe: null, read_error: null };

  let record: ConnectionRecord | null;
  try {
    record = await readConnectionRecord("agy");
  } catch (err) {
    // A corrupt record is NOT "never checked": those two produce identical
    // amber for entirely different reasons, and only one of them is our fault.
    return {
      installed: true,
      probe: {
        state: "unknown",
        identity: null,
        checked_at: null,
        detail: `The stored agy status record could not be read, so this row has no evidence to show: ${(err as Error).message}`,
      },
      read_error: (err as Error).message,
    };
  }

  try {
    return {
      installed: true,
      probe: renderState(record, {
        now: nowMs,
        intervalMs: connectionRecheckIntervalMs(),
      }),
      read_error: null,
    };
  } catch (err) {
    // `renderState` throws on an unparseable `checked_at` and on a
    // non-positive interval. Same rule: rendered, not thrown, not defaulted.
    return {
      installed: true,
      probe: {
        state: "unknown",
        identity: null,
        checked_at: null,
        detail: `The stored agy status record could not be rendered: ${(err as Error).message}`,
      },
      read_error: (err as Error).message,
    };
  }
}

/* ── GitHub (R55, R56) ───────────────────────────────────────────────────── */

/**
 * The secret-store name the PAT arrives under, via `POST /api/secrets` and the
 * `forge:ui` secret block — never a brief, a chat message, a log line, a URL
 * or a query string.
 */
export const GITHUB_PAT_SECRET = "github-pat";

/** Overridable so a test can point the probe at a local throwaway server and
 *  cover all three states without a real token on the wire. */
export function githubApiBase(): string {
  return process.env.GITHUB_API_BASE ?? "https://api.github.com";
}

export const GITHUB_TIMEOUT_MS = 8_000;

/** Nothing upstream is relayed unscrubbed. GitHub does not echo the token in
 *  any documented error body; this exists so that an UNDOCUMENTED one cannot
 *  become a leak — the same posture this router already takes for the Gemini
 *  key and the Google refresh token. */
export function scrubToken(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("<redacted>");
}

export interface HttpProbeOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * A real `GET /user` with the token in an Authorization HEADER — never a query
 * string, which would land in an access log. "Token present" is storage, not
 * authorisation, and never renders as connected: only a 200 with a `login` in
 * the body does.
 *
 * On success `identity` is the login GitHub returned and the detail carries
 * the `x-oauth-scopes` RESPONSE HEADER verbatim, including the case where it
 * is empty (a fine-grained PAT reports no classic scopes) or absent — stated
 * as such rather than rendered as "no permissions".
 */
export async function probeGithub(
  token: string,
  opts: HttpProbeOptions = {},
): Promise<ConnectionRecord> {
  const checkedAt = new Date().toISOString();
  const base = (opts.baseUrl ?? githubApiBase()).replace(/\/+$/, "");
  const url = `${base}/user`;
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? GITHUB_TIMEOUT_MS;

  let res: Response;
  try {
    res = await doFetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "forge-control-connection-probe",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const e = err as Error;
    const timedOut = e.name === "TimeoutError" || e.name === "AbortError";
    return {
      ok: false,
      identity: null,
      detail: timedOut
        ? `${url} did not answer within ${timeoutMs}ms. The token was NOT tested — this says nothing about whether it is valid.`
        : `Could not reach ${url}: ${scrubToken(e.message, token)}`,
      checked_at: checkedAt,
    };
  }

  const body = scrubToken(await res.text(), token);
  const scopesHeader = res.headers.get("x-oauth-scopes");

  if (!res.ok) {
    return {
      ok: false,
      identity: null,
      detail: withUpstream(
        `GitHub rejected the stored personal access token at GET ${url}.`,
        res.status,
        body.slice(0, 600) || "(empty body)",
      ),
      checked_at: checkedAt,
    };
  }

  let login: string | null = null;
  let accountId: number | null = null;
  try {
    const parsed = JSON.parse(body) as { login?: unknown; id?: unknown };
    login = typeof parsed.login === "string" && parsed.login ? parsed.login : null;
    accountId = typeof parsed.id === "number" ? parsed.id : null;
  } catch (err) {
    return {
      ok: false,
      identity: null,
      detail: withUpstream(
        `GitHub answered 200 at GET ${url} with a body that is not JSON (${(err as Error).message}). Treat the token as untested rather than valid.`,
        res.status,
        body.slice(0, 400),
      ),
      checked_at: checkedAt,
    };
  }

  if (login === null) {
    return {
      ok: false,
      identity: null,
      detail: withUpstream(
        `GitHub answered 200 at GET ${url} but the body carries no \`login\`, so there is no verified identity to show.`,
        res.status,
        body.slice(0, 400),
      ),
      checked_at: checkedAt,
    };
  }

  const scopes =
    scopesHeader === null
      ? "x-oauth-scopes: header absent — GitHub sends it only for classic tokens, so this is a fine-grained PAT and its permissions are only visible in the token's own settings page."
      : scopesHeader.trim() === ""
        ? "x-oauth-scopes: present but EMPTY — a fine-grained PAT, or a classic token with no scopes selected."
        : `x-oauth-scopes: ${scopesHeader}`;

  return {
    ok: true,
    identity: login,
    detail: `GET ${url} answered HTTP ${res.status} as ${login}${accountId === null ? "" : ` (account id ${accountId})`}. ${scopes}`,
    checked_at: checkedAt,
  };
}

/* ── Google Workspace (R48–R51) ──────────────────────────────────────────── */

/** Where `setup.py` writes the credential (TOKEN_PATH = HERMES_HOME/google_token.json). */
export function googleTokenPath(): string {
  return process.env.GOOGLE_TOKEN_PATH ?? "/root/.hermes/google_token.json";
}

export const GOOGLE_SETUP_SCRIPT = "/opt/ai-os/google-setup/setup.py";
export const GOOGLE_REAUTH_COMMAND = `python3 ${GOOGLE_SETUP_SCRIPT}`;
export const GMAIL_PROFILE_URL =
  "https://gmail.googleapis.com/gmail/v1/users/me/profile";
export const GOOGLE_TIMEOUT_MS = 8_000;

export interface GoogleTokenFile {
  account?: unknown;
  scopes?: unknown;
  client_id?: unknown;
  client_secret?: unknown;
  refresh_token?: unknown;
  token_uri?: unknown;
  expiry?: unknown;
}

/**
 * The probe result plus the fields the route still reports separately for the
 * existing `last_check` contract. `record.detail` already contains everything
 * here — these are a convenience for the client, not a second source of truth.
 */
export interface GoogleProbeResult {
  record: ConnectionRecord;
  /** Machine-readable failure class, or null on success. */
  reason: string | null;
  http_status: number | null;
  /** Google's own words, scrubbed of the refresh token and client secret. */
  upstream: string | null;
}

/**
 * Spend the refresh token once and ask Gmail who we are. This is the ONLY way
 * to distinguish "connected" from "invalid_grant", and it is also where the
 * connected email comes from: the credential file leaves `account` empty and
 * `userinfo` is out of scope on this consent, so Gmail's own profile endpoint
 * is the address of record (R50).
 *
 * NOTHING IS WRITTEN BACK. The refreshed access token is used for one call and
 * dropped; the credential file on disk is not opened for writing anywhere on
 * this path. phase4/google-persistence-proof.md carries the sha256 of the file
 * before and after to prove it.
 */
export async function probeGoogle(
  opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<GoogleProbeResult> {
  const checkedAt = new Date().toISOString();
  const path = googleTokenPath();
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? GOOGLE_TIMEOUT_MS;

  const fail = (
    reason: string,
    detail: string,
    httpStatus: number | null,
    upstream: string | null,
  ): GoogleProbeResult => ({
    record: { ok: false, identity: null, detail, checked_at: checkedAt },
    reason,
    http_status: httpStatus,
    upstream,
  });

  let parsed: GoogleTokenFile;
  try {
    parsed = JSON.parse(await readFile(path, "utf8")) as GoogleTokenFile;
  } catch (err) {
    return fail(
      "no_credential",
      `Could not read the Google credential at ${path}: ${(err as Error).message}`,
      null,
      null,
    );
  }

  const refresh = typeof parsed.refresh_token === "string" ? parsed.refresh_token : "";
  const clientId = typeof parsed.client_id === "string" ? parsed.client_id : "";
  const clientSecret =
    typeof parsed.client_secret === "string" ? parsed.client_secret : "";
  const tokenUri =
    typeof parsed.token_uri === "string"
      ? parsed.token_uri
      : "https://oauth2.googleapis.com/token";

  if (!refresh || !clientId || !clientSecret) {
    return fail(
      "incomplete_credential",
      `The credential file at ${path} is missing the refresh token or the client identity, so it cannot be renewed. Re-run \`${GOOGLE_REAUTH_COMMAND}\`.`,
      null,
      null,
    );
  }

  /** Google's error bodies quote neither secret, but the rule on this path is
   *  that nothing upstream is relayed unscrubbed. */
  const clean = (text: string): string =>
    text.split(refresh).join("<redacted>").split(clientSecret).join("<redacted>");

  let tokenRes: Response;
  try {
    tokenRes = await doFetch(tokenUri, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refresh,
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return fail(
      "unreachable",
      `Could not reach Google's token endpoint at ${tokenUri}: ${clean((err as Error).message)}`,
      null,
      null,
    );
  }

  const tokenBody = clean(await tokenRes.text());
  if (!tokenRes.ok) {
    const isInvalidGrant = tokenBody.includes("invalid_grant");
    // R58: keep the explanation, but NEVER instead of Google's own answer.
    // An expired consent and a 503 from Google's token endpoint used to render
    // as the same friendly sentence.
    return fail(
      isInvalidGrant ? "invalid_grant" : "token_refresh_failed",
      withUpstream(
        isInvalidGrant
          ? `Google refused the refresh token (invalid_grant) — the consent was revoked, the password changed, or the token expired. Gmail, Calendar and Drive are dead until it is re-authorised, and that needs \`${GOOGLE_REAUTH_COMMAND}\` at a terminal.`
          : `Google refused to renew the access token at ${tokenUri}.`,
        tokenRes.status,
        tokenBody.slice(0, 600) || "(empty body)",
      ),
      tokenRes.status,
      tokenBody.slice(0, 600),
    );
  }

  let accessToken = "";
  try {
    const j = JSON.parse(tokenBody) as { access_token?: unknown };
    accessToken = typeof j.access_token === "string" ? j.access_token : "";
  } catch (err) {
    return fail(
      "token_refresh_failed",
      withUpstream(
        `Google's token endpoint answered HTTP ${tokenRes.status} with a body that is not JSON (${(err as Error).message}).`,
        tokenRes.status,
        tokenBody.slice(0, 400),
      ),
      tokenRes.status,
      tokenBody.slice(0, 400),
    );
  }
  if (!accessToken) {
    return fail(
      "token_refresh_failed",
      withUpstream(
        "Google's token response carried no access_token.",
        tokenRes.status,
        tokenBody.slice(0, 400),
      ),
      tokenRes.status,
      tokenBody.slice(0, 400),
    );
  }

  let profileRes: Response;
  try {
    profileRes = await doFetch(GMAIL_PROFILE_URL, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return fail(
      "unreachable",
      `The token refreshed, so the consent is alive, but ${GMAIL_PROFILE_URL} did not answer: ${clean((err as Error).message)}`,
      null,
      null,
    );
  }

  const profileBody = clean(await profileRes.text());
  if (!profileRes.ok) {
    return fail(
      "profile_failed",
      withUpstream(
        `The token refreshed, so the consent is alive, but Gmail refused the profile call at ${GMAIL_PROFILE_URL}.`,
        profileRes.status,
        profileBody.slice(0, 600) || "(empty body)",
      ),
      profileRes.status,
      profileBody.slice(0, 600),
    );
  }

  let email: string | null = null;
  try {
    const j = JSON.parse(profileBody) as { emailAddress?: unknown };
    email = typeof j.emailAddress === "string" && j.emailAddress ? j.emailAddress : null;
  } catch (err) {
    return fail(
      "profile_failed",
      withUpstream(
        `Gmail answered HTTP ${profileRes.status} at ${GMAIL_PROFILE_URL} with a body that is not JSON (${(err as Error).message}), so there is no verified address.`,
        profileRes.status,
        profileBody.slice(0, 400),
      ),
      profileRes.status,
      profileBody.slice(0, 400),
    );
  }

  if (email === null) {
    // A 200 with no address is not a verified identity. R57's sibling rule:
    // an identity we did not receive is not one we may display.
    return fail(
      "profile_failed",
      withUpstream(
        `Gmail answered HTTP ${profileRes.status} at ${GMAIL_PROFILE_URL} but returned no emailAddress, so the account cannot be named.`,
        profileRes.status,
        profileBody.slice(0, 400),
      ),
      profileRes.status,
      profileBody.slice(0, 400),
    );
  }

  return {
    record: {
      ok: true,
      identity: email,
      detail: `Google renewed the access token at ${tokenUri} and Gmail answered HTTP ${profileRes.status} at ${GMAIL_PROFILE_URL} as ${email}.`,
      checked_at: checkedAt,
    },
    reason: null,
    http_status: profileRes.status,
    upstream: null,
  };
}

/* ── Re-check pass, shared by the route layer and cron-tick ──────────────── */

export const CONNECTION_IDS = ["google", "agy", "github"] as const;
export type ConnectionId = (typeof CONNECTION_IDS)[number];

/** Exported for the unit test that asserts the binary is addressed absolutely
 *  (R52). Kept next to AGY_BIN so the assertion and the value cannot drift. */
export function agyBinIsAbsolute(): boolean {
  return isAbsolute(AGY_BIN);
}

/**
 * Resolve the GitHub PAT, and say plainly what is there when it is not the one
 * we want. The store on this box already holds `github-pat-konrad` and
 * `github-pat-shane`; picking one of those silently would be a guess about
 * which account Konrad means, and this lane exists to stop exactly that class
 * of confident invention. So: the canonical name only, with the near misses
 * NAMED in the absent detail so the next step is obvious.
 */
export async function resolveGithubToken(
  listNames: () => Promise<string[]>,
  readSecret: (name: string) => Promise<string | null>,
): Promise<{ token: string } | { token: null; candidates: string[] }> {
  const stored = await readSecret(GITHUB_PAT_SECRET);
  if (stored !== null && stored.trim() !== "") return { token: stored.trim() };
  const names = await listNames();
  return {
    token: null,
    candidates: names.filter(
      (n) => n !== GITHUB_PAT_SECRET && (n.startsWith("github") || n.includes("-pat")),
    ),
  };
}

/**
 * Run one probe and persist its record. Returns the record it stored.
 *
 * NEVER THROWS FOR AN UPSTREAM FAILURE — a failed probe is a RECORDED failure
 * (`ok:false` with the verbatim error), which is the opposite of a silent
 * fallback: the answer is preserved, it is simply a "no". It DOES throw if the
 * status store itself cannot be written, because that is this box's own fault
 * and hiding it would leave the surface reporting a `checked_at` that never
 * reached disk.
 */
export async function probeAndPersist(
  id: ConnectionId,
  probe: () => Promise<ConnectionRecord>,
): Promise<ConnectionRecord> {
  return await writeConnectionRecord(id, await probe());
}

export interface RecheckOutcome {
  id: ConnectionId;
  ok: boolean;
  /** Set only when the re-check itself could not be completed — a bug in this
   *  process or an unwritable store, NOT an upstream saying no. */
  error: string | null;
}

/**
 * The scheduled pass (R51), hung off cron-tick's existing timer.
 *
 * Every probe is isolated: one integration blowing up cannot stop the other
 * two from being refreshed, and nothing here propagates an exception into the
 * tick. An upstream failure is persisted as `ok:false` with its verbatim
 * error. An internal failure — the probe function itself throwing, or the
 * status store refusing a write — is returned in `error` so the caller can log
 * it loudly; it is never converted into a health verdict, because "our probe
 * crashed" and "GitHub said 401" are different facts and must not render the
 * same (N1).
 *
 * GitHub is skipped when no PAT is stored: there is nothing to probe, and
 * writing an `ok:false` record for a credential that was never supplied would
 * turn ABSENT into BROKEN and invent a problem.
 */
export async function recheckAllConnections(deps: {
  listSecretNames: () => Promise<string[]>;
  readSecret: (name: string) => Promise<string | null>;
}): Promise<RecheckOutcome[]> {
  const one = async (
    id: ConnectionId,
    probe: () => Promise<ConnectionRecord>,
  ): Promise<RecheckOutcome> => {
    try {
      const record = await probeAndPersist(id, probe);
      return { id, ok: record.ok, error: null };
    } catch (err) {
      return { id, ok: false, error: (err as Error).message };
    }
  };

  const results: RecheckOutcome[] = [];
  results.push(await one("google", async () => (await probeGoogle()).record));
  results.push(await one("agy", () => probeAgy()));

  try {
    const resolved = await resolveGithubToken(deps.listSecretNames, deps.readSecret);
    if (resolved.token !== null) {
      results.push(await one("github", () => probeGithub(resolved.token)));
    }
  } catch (err) {
    results.push({ id: "github", ok: false, error: (err as Error).message });
  }
  return results;
}
