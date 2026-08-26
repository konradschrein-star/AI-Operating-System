/**
 * Gemini engine — `agy -p` as a run executor's brain, beside `claude -p`.
 *
 * Konrad's Google AI Pro plan is reachable only through the Antigravity CLI
 * (Google retired the standalone Gemini CLI's individual client on 2026-06-18).
 * `agy` signed in on 2026-08-22; this module turns that credential into a second
 * engine so cheap parallelisable work stops competing for the Claude usage
 * window, which is the real budget.
 *
 * ── WHY IT LOOKS LIKE cc-runner AND RETURNS ITS TYPES ────────────────────────
 * `runClaudeCode` is the ONE door every run goes through — chat, projects,
 * tickers. Rather than add a second door and then spend months keeping two call
 * sites in step, this returns `CcResult` and emits `CcEvent`, and the dispatcher
 * picks an engine from the model id. Adding Gemini to a caller is then not a
 * change to that caller at all.
 *
 * ── THE ONE FLAG THAT IS NOT OPTIONAL: --add-dir ─────────────────────────────
 * MEASURED 2026-08-22, and it is the reason this file has a hard assertion in
 * it. Told to "create proof.txt in the current working directory", `agy` with a
 * correct `cwd` and no `--add-dir` wrote to
 * `/root/.gemini/antigravity-cli/scratch/proof.txt`, reported
 * `"status":"SUCCESS"`, and said in prose that it had created the file. The cwd
 * was untouched. With `--add-dir <cwd>` the identical prompt wrote to the real
 * directory and `pwd` agreed.
 *
 * So a worker without `--add-dir` does its whole job in a scratch directory and
 * every signal says it succeeded: exit 0, SUCCESS, a confident summary. The git
 * worktree is simply empty afterwards. That is indistinguishable from "the model
 * was lazy" and would be debugged as a prompt problem for hours. The workdir is
 * therefore always passed, and a missing one throws rather than defaulting.
 *
 * ── WHAT THIS ENGINE IS GOOD FOR ─────────────────────────────────────────────
 * gemini-3.7-flash-high (Google, 2026-08-13). DeepSWE long-horizon coding
 * 65.3% (from 49.0%), FrontierCode 43.6% (from 34.4%), AutomationBench 30.4%
 * (from 17.0%), WebDev Arena Elo 1588. 1M input context, 64k max output.
 * Built for high-volume latency-sensitive work: sustained multi-file edits,
 * agentic tool use, scaffolding, tests, boilerplate, research sweeps.
 *
 * Google's own guidance, and this codebase's: route by task complexity, not
 * prestige. It is NOT the tool for one-shot architectural decisions where a
 * wrong answer is expensive, or for work needing the highest reasoning ceiling —
 * that stays Opus/Fable. Which is exactly the split this engine exists to make
 * possible.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  CcResumeError,
  uploadsRunId,
  type CcEvent,
  type CcResult,
} from "./cc-runner.ts";
import { recordSpend } from "../db/spend.ts";

/** Absolute. pm2's PATH has no /root/.local/bin — that export lives in
 *  `.bashrc`, which pm2 never sources — so a bare `spawn("agy")` is ENOENT
 *  under the server and works perfectly over SSH. */
export const AGY_BIN = "/root/.local/bin/agy";

/** Linux `MAX_ARG_STRLEN`: the biggest single argv entry execve will accept,
 *  32 pages including the trailing NUL. Verified empirically against agy on
 *  this host — 131071 bytes spawns, 131072 throws E2BIG. */
export const MAX_ARG_STRLEN = 131072;

/** The only Gemini model this OS runs. Konrad, 2026-08-22: "We'll always use
 *  gemini-3.7-flash-high." */
export const GEMINI_MODEL = "gemini-3.7-flash-high";

export const GEMINI_MODEL_PREFIX = "gemini-";

/** Does this model id belong to the Gemini engine rather than Claude? */
export function isGeminiModel(model: string | null | undefined): boolean {
  return typeof model === "string" && model.startsWith(GEMINI_MODEL_PREFIX);
}

/** agy's result envelope. Under `--output-format stream-json` it arrives as the
 *  `result` member of the final `{"event":"result",...}` line; under the older
 *  `json` mode it was the whole document. Both shapes are accepted. */
interface AgyEnvelope {
  conversation_id?: string;
  status?: string;
  response?: string;
  /** agy's own reason for a non-SUCCESS status — e.g. "authentication failed or
   *  timed out". Measured 2026-08-26: this field is the difference between a
   *  legible failure and the infamous "status ERROR with no response text",
   *  which for months hid an expired OAuth token behind a message that read
   *  like a model failure. Always surfaced. */
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    thinking_tokens?: number;
    cache_read_tokens?: number;
    total_tokens?: number;
  };
}

/** One line of agy's `stream-json`. Only `result` carries the answer; the rest
 *  (`init`, `step_update`, …) exist to prove the run is still alive. */
interface AgyStreamLine {
  event?: string;
  result?: AgyEnvelope;
}

/**
 * Pull the result envelope out of whatever agy printed.
 *
 * Exported for tests, and deliberately tolerant of BOTH output modes: the
 * stream emits one JSON object per line and the answer is the `result` member
 * of the final `{"event":"result"}` line, while the older `--output-format
 * json` printed a single bare document. A version of agy that changes its mind
 * about which it gives us must not take the fleet down, so both are read and
 * the LAST usable envelope wins.
 *
 * Returns null when nothing parseable was printed at all — which the caller
 * reports with agy's stderr attached, because that is the case where the
 * reason lives outside the JSON.
 */
export function parseAgyStdout(raw: string): AgyEnvelope | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  let found: AgyEnvelope | null = null;
  for (const line of trimmed.split("\n")) {
    const s = line.trim();
    if (s === "" || !s.startsWith("{")) continue;
    let parsed: AgyStreamLine & AgyEnvelope;
    try {
      parsed = JSON.parse(s) as AgyStreamLine & AgyEnvelope;
    } catch {
      continue; // a progress line, or a chunk boundary — not fatal on its own
    }
    if (parsed.event === "result" && parsed.result) found = parsed.result;
    // The legacy single-document shape: no `event`, but it carries an answer.
    else if (parsed.event === undefined && (parsed.status !== undefined || parsed.response !== undefined)) {
      found = parsed as AgyEnvelope;
    }
  }
  if (found !== null) return found;

  /* Last resort, inherited from the json-mode parser: agy has been seen to
   * print progress text before its envelope, and a truncated final line is
   * likelier than a truncated earlier one. Take the last balanced object. */
  const last = trimmed.lastIndexOf("{");
  if (last >= 0) {
    try {
      return JSON.parse(trimmed.slice(last)) as AgyEnvelope;
    } catch {
      return null;
    }
  }
  return null;
}

export interface SessionUsageSnapshot {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  thinking_tokens: number;
}

const sessionUsageMap = new Map<string, SessionUsageSnapshot>();

export function getSessionUsageSnapshot(
  sessionId: string,
): SessionUsageSnapshot | undefined {
  return sessionUsageMap.get(sessionId);
}

export function setSessionUsageSnapshot(
  sessionId: string,
  snapshot: SessionUsageSnapshot,
): void {
  sessionUsageMap.set(sessionId, snapshot);
}

export function clearSessionUsageSnapshot(sessionId: string): void {
  sessionUsageMap.delete(sessionId);
}

function numOr0(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (v as number);
  return Number.isFinite(n) ? n : 0;
}

export interface GeminiRunOptions {
  prompt: string;
  systemPrompt?: string | null;
  /** REQUIRED. See the --add-dir note at the top of this file. */
  cwd: string;
  /** Extra directories the run may touch — e.g. the Obsidian vault. */
  addDirs?: readonly string[];
  /** agy conversation id, to continue a thread. */
  sessionId?: string | null;
  model?: string | null;
  timeoutMs?: number;
  /** The `runs.id` this turn belongs to. */
  runId?: string | null;
  onEvent?: (e: CcEvent) => void;
  isCancelled?: () => Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 900_000;

/** The one true wall-clock stop for a runaway loop, mirroring cc-runner.ts so
 *  both engines are bounded the same way. 4h default; override with
 *  RUN_MAX_WALL_MS. */
const MAX_WALL_MS = Number(process.env.RUN_MAX_WALL_MS ?? String(4 * 60 * 60_000));

/**
 * Run one Gemini turn and return it in `CcResult` shape.
 *
 * `costUsd` is 0 and that is a statement, not a stub: this draws on a flat
 * Google AI Pro subscription, so a per-token dollar figure would be a fiction.
 * Token counts are reported through the usage event, where they are real.
 */
export async function runGemini(opts: GeminiRunOptions): Promise<CcResult> {
  if (!opts.cwd || opts.cwd.trim() === "") {
    // Refuse rather than default. A silent scratch-directory run reports
    // success and produces nothing; a throw is legible in one read of a log.
    throw new Error(
      "runGemini requires an explicit cwd — without --add-dir agy writes to its own scratch directory and still reports SUCCESS",
    );
  }

  const model = opts.model && opts.model.trim() !== "" ? opts.model : GEMINI_MODEL;
  const started = Date.now();

  const prompt =
    opts.systemPrompt && opts.systemPrompt.trim() !== ""
      ? `${opts.systemPrompt}\n\n---\n\n${opts.prompt}`
      : opts.prompt;
  // agy has no --append-system-prompt, so the system prompt is prepended to the
  // user turn. Stated plainly because it is a real difference from the Claude
  // engine: there is no privileged channel, and a prompt-injecting document can
  // address these instructions the same way it addresses the task.

  const budgetMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  /* ── The two ceilings that made Gemini look incapable ──────────────────────
   *
   * MEASURED 2026-08-25/26 across a full fleet day: 16 of 18 gemini runs died,
   * in two clean clusters, and NEITHER was the model failing at the work.
   *
   *   ~307s  `status ERROR` with an empty response — agy's OWN `--print-timeout`,
   *          which defaults to 5m0s and which this runner never set.
   *   ~600s  `agy exceeded 600000ms` — this runner's wall-clock kill, fed the
   *          same `timeoutMs` the Claude runner treats as an IDLE budget.
   *
   * Real work on this fleet, same day: builders average 15.7 min and reach 51;
   * reviewers average 11. Both ceilings sat BELOW the median task, so a Gemini
   * builder could not finish a normal task however good the model was — and
   * every death was retried once and then re-run on Claude, which is where the
   * "Gemini is unreliable" reputation and the Claude bill both came from.
   *
   * So: tell agy the same budget we enforce, in the Go duration it parses, and
   * give it a minute of headroom so OUR timer is the one that fires first and
   * reports the honest reason. */
  const args = buildAgyArgs({
    prompt,
    model,
    budgetMs,
    cwd: opts.cwd,
    addDirs: opts.addDirs,
    sessionId: opts.sessionId,
  });

  const env = { ...process.env };
  // A stray key would silently move this run off the subscription and onto
  // metered billing — the failure mode is an invoice, not an error.
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;
  if (opts.runId) {
    try {
      env.FORGE_RUN_ID = uploadsRunId(opts.runId);
      env.FORGE_RUN_UUID = opts.runId;
    } catch {
      // Non-UUID run id — leave unset
    }
  }

  return await runAgy(args, env, prompt, budgetMs, opts, model, started);
}

/**
 * The exact argv handed to agy — exported because the 2026-08-26 fix IS these
 * flags, and a fix that lives only in an argument list is one careless edit
 * away from silently reverting to the two stacked timeouts it removed.
 */
export function buildAgyArgs(input: {
  prompt: string;
  model: string;
  budgetMs: number;
  cwd: string;
  addDirs?: readonly string[];
  sessionId?: string | null;
}): string[] {
  const printTimeoutMin = Math.max(1, Math.ceil(input.budgetMs / 60_000) + 1);

  const args = [
    "-p", input.prompt,
    "--model", input.model,
    /* stream-json, not json: the ONLY reason is the idle budget below. agy
     * emits nothing until the end in `json` mode, so a long-but-healthy run is
     * indistinguishable from a hung one and the runner must guess with a
     * wall-clock timer. Streaming turns that guess into a measurement.
     * Verified 2026-08-26 that this works with stdin ignored — the auth path's
     * stdin appetite is unchanged and unrelated. */
    "--output-format", "stream-json",
    `--print-timeout`, `${printTimeoutMin}m`,
    // Non-interactive by construction: there is no human at this terminal to
    // approve a tool call, so an approval prompt is a hang, not a safeguard.
    "--dangerously-skip-permissions",
    // The whole point — see the header.
    "--add-dir", input.cwd,
  ];
  for (const d of input.addDirs ?? []) args.push("--add-dir", d);
  if (input.sessionId) args.push("--conversation", input.sessionId);
  return args;
}

/** Spawn agy with a prepared argv and turn its stream into a `CcResult`. */
async function runAgy(
  args: string[],
  env: NodeJS.ProcessEnv,
  prompt: string,
  budgetMs: number,
  opts: GeminiRunOptions,
  model: string,
  started: number,
): Promise<CcResult> {
  /* ── The 128 KiB argv cliff ────────────────────────────────────────────────
   *
   * The whole prompt travels as ONE argv entry (`-p prompt`), and Linux caps a
   * single argument at MAX_ARG_STRLEN — 32 pages, 131072 bytes, NUL included.
   * Measured on this host: a 131071-byte prompt spawns; 131072 throws E2BIG.
   *
   * Two reasons this needs an explicit guard rather than being left to the
   * kernel. First, node throws E2BIG SYNCHRONOUSLY out of `spawn()` — it is not
   * delivered to the `'error'` listener below, so without a try/catch it
   * escapes as an unhandled throw from inside the promise executor and the
   * caller sees a stack trace instead of an engine result. Second, the message
   * would say "spawn E2BIG" and nothing about prompts, which is a bad thing to
   * meet at 3am.
   *
   * Headroom today is wide: the system prompt is ~9.5 KB and the largest brief
   * in the database is ~40 KB, so ~50 KB against a 128 KB ceiling. Briefs grow.
   * agy offers no --prompt-file, and its only stdin channel
   * (--input-format stream-json) is the same stdin the auth path blocks on, so
   * there is no bigger door to route this through — the honest move is to fail
   * with the numbers in the message. */
  const promptBytes = Buffer.byteLength(prompt, "utf8");
  if (promptBytes >= MAX_ARG_STRLEN) {
    throw new Error(
      `agy prompt is ${promptBytes} bytes, over the ${MAX_ARG_STRLEN}-byte single-argument ` +
        `limit (Linux MAX_ARG_STRLEN); it cannot be passed on the command line. ` +
        `Shorten the brief or the system prompt.`,
    );
  }

  return await new Promise<CcResult>((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(AGY_BIN, args, {
        cwd: opts.cwd,
        env,
        // stdin MUST be ignored. agy's auth path reads stdin, and a pipe nobody
        // writes to never yields EOF — measured: the process was still running at
        // 12s with a pipe, and answered in 372ms with /dev/null.
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      /* Belt and braces for the OTHER limit: the guard above bounds ONE
       * argument, while ARG_MAX bounds the whole vector plus the environment.
       * A pile of --add-dir paths could in principle trip that even with a
       * legal prompt, and it arrives by the same synchronous throw. */
      reject(
        new Error(
          `agy could not be spawned (${(e as NodeJS.ErrnoException).code ?? "unknown"}): ` +
            `prompt ${promptBytes} bytes, ${args.length} argv entries.`,
        ),
      );
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    let lastEventAt = Date.now();
    let streamEvents = 0;

    /* `timeoutMs` is now an IDLE budget here, exactly as it already was in
     * cc-runner.ts — the two engines finally mean the same thing by the same
     * number. Any stream event resets it; we only kill when agy has genuinely
     * gone quiet for the whole window. MAX_WALL_MS is the one true stop for a
     * runaway loop. */
    let timer = setTimeout(onIdle, budgetMs);
    function onIdle() {
      if (settled) return;
      settled = true;
      clearTimeout(wallTimer);
      child.kill("SIGKILL");
      const quietFor = Math.round((Date.now() - lastEventAt) / 1000);
      reject(
        new Error(
          `agy went silent for ${quietFor}s (idle budget ${Math.round(budgetMs / 1000)}s) ` +
            `after ${streamEvents} stream event(s).`,
        ),
      );
    }
    const bumpIdle = () => {
      if (settled) return;
      lastEventAt = Date.now();
      clearTimeout(timer);
      timer = setTimeout(onIdle, budgetMs);
    };
    const wallTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new Error(`agy exceeded the ${Math.round(MAX_WALL_MS / 60_000)}min wall-clock stop`));
    }, MAX_WALL_MS);

    const cancelPoll = opts.isCancelled
      ? setInterval(() => {
          void opts.isCancelled!().then((c) => {
            if (c && !settled) {
              settled = true;
              clearTimeout(timer);
              clearTimeout(wallTimer);
              child.kill("SIGKILL");
              reject(new Error("cancelled"));
            }
          });
        }, 5000)
      : null;

    /* Every NDJSON line agy emits is proof of life, and that is the entire
     * point of the format change: a builder 40 minutes into a hard task keeps
     * resetting the clock, while a genuinely wedged one stops and gets killed.
     * The lines are also counted so a silent death can say how far it got. */
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      const chunk = d.toString();
      for (const line of chunk.split("\n")) {
        if (line.trim() === "") continue;
        streamEvents++;
        bumpIdle();
      }
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    // `close`, not `exit`: exit can fire before the last stdout chunk is read,
    // which would truncate the very JSON the result is parsed from.
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(wallTimer);
      if (cancelPoll !== null) clearInterval(cancelPoll);

      const env2 = parseAgyStdout(stdout);

      if (env2 === null) {
        if (opts.sessionId && /conversation.*not found/i.test(stderr)) {
          reject(new CcResumeError(`resume ${opts.sessionId} failed: ${stderr.trim()}`));
          return;
        }
        reject(
          new Error(
            `agy produced no parseable JSON (exit ${code}).${stderr.trim() ? ` STDERR: ${stderr.trim().slice(0, 400)}` : ""}`,
          ),
        );
        return;
      }

      /* ── agy's `status` IS NOT A RELIABLE SUCCESS SIGNAL ────────────────────
       * MEASURED 2026-08-22: the SAME code and the SAME prompt, run twice back
       * to back, returned `"status":"ERROR"` then `"status":"SUCCESS"`. Both
       * runs answered correctly AND wrote the file they were asked to write.
       * It is not a failing tool call — a deliberately failing `ls` still
       * reports SUCCESS — and it is not the long system prompt, which reports
       * SUCCESS on its own. It is simply flaky.
       *
       * So the RESPONSE is the source of truth and the status is advisory.
       * Trusting the status would fail roughly half of all Gemini runs while
       * their work sat completed on disk — the worst kind of bug, because the
       * retry would redo work that had already succeeded.
       *
       * A non-SUCCESS status with NO response is still a real failure: there is
       * nothing to hand back, so there is nothing to salvage. */
      const text = env2.response ?? "";

      if (env2.status !== undefined && env2.status !== "SUCCESS" && text.trim() === "") {
        if (opts.sessionId && /conversation.*not found/i.test(stderr)) {
          reject(new CcResumeError(`resume ${opts.sessionId} failed: ${stderr.trim()}`));
          return;
        }
        /* agy's own `error` first. Without it this line read "status ERROR with
         * no response text" for an EXPIRED OAUTH TOKEN — a message that sent
         * everyone hunting the model and the prompt for something that was
         * neither. Measured 2026-08-26: the envelope said
         * `"error":"authentication failed or timed out"` the whole time. */
        reject(
          new Error(
            `agy returned status ${env2.status} with no response text` +
              (env2.error ? ` — ${env2.error}` : ".") +
              (stderr.trim() ? ` STDERR: ${stderr.trim().slice(0, 400)}` : ""),
          ),
        );
        return;
      }



      const usageIn = numOr0(env2.usage?.input_tokens);
      const usageOut = numOr0(env2.usage?.output_tokens);
      const usageCache = numOr0(env2.usage?.cache_read_tokens);
      const thinkingTokens = numOr0(env2.usage?.thinking_tokens);

      /* ── agy returns CUMULATIVE session tokens ──────────────────────────────
       * When `--conversation <cid>` is passed to agy, `env2.usage` is the sum
       * of tokens across all turns in that session rather than the delta for
       * this turn alone.
       *
       * The context gauge in the UI (`usage_running`) measures the ACTIVE turn's
       * context occupancy. The exact prompt sent to Gemini on this turn is
       * `prompt` (`promptBytes / 4` tokens).
       *
       * Emitting `cache_read_tokens` (which agy accumulates over every single
       * prior turn in the session) caused `usage_running` to inflate to 2751%+.
       *
       * By reporting `turnContextTokens` as `input_tokens` and 0 for
       * `cache_read_input_tokens`, the context gauge stays 100% accurate,
       * `spend_log` records exact per-turn token spend, and `usage_total`
       * tracks the real sum. */
      const turnContextTokens = Math.max(1, Math.round(promptBytes / 4));
      const cid = env2.conversation_id || opts.sessionId;
      let deltaOut = usageOut;
      let deltaThinking = thinkingTokens;

      if (opts.sessionId) {
        const prev = sessionUsageMap.get(opts.sessionId);
        if (prev) {
          deltaOut = Math.max(0, usageOut - prev.output_tokens);
          deltaThinking = Math.max(0, thinkingTokens - prev.thinking_tokens);
        }
      }

      if (cid) {
        sessionUsageMap.set(cid, {
          input_tokens: usageIn,
          output_tokens: usageOut,
          cache_read_tokens: usageCache,
          thinking_tokens: thinkingTokens,
        });
      }

      /* ── Feed the indicator row ────────────────────────────────────────────
       * `GET /api/usage/quota` builds the `gem` tally from spend_log rows where
       * provider ILIKE 'gemini%', summing `units`.
       *
       * amount_eur is 0.0 and MEANS zero: this is a flat Google AI Pro
       * subscription, so there is no marginal euro to record. The tokens are
       * the real reading, and they go in `units`. */
      void recordSpend([
        {
          provider: "gemini",
          kind: "llm_input",
          amount_eur: 0,
          units: turnContextTokens,
          meta: { model, conversation_id: env2.conversation_id ?? null, engine: "agy" },
        },
        {
          provider: "gemini",
          kind: "llm_output",
          amount_eur: 0,
          units: deltaOut,
          meta: {
            model,
            conversation_id: env2.conversation_id ?? null,
            engine: "agy",
            thinking_tokens: deltaThinking,
            status: env2.status ?? null,
          },
        },
      ]).catch(() => undefined);

      if (opts.onEvent) {
        opts.onEvent({
          type: "assistant_text",
          text,
          sessionId: env2.conversation_id,
          model,
          usage: {
            input_tokens: turnContextTokens,
            output_tokens: deltaOut,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        });
      }

      resolve({
        text,
        sessionId: env2.conversation_id ?? null,
        // Flat subscription — a dollar figure would be invented. Tokens are in
        // the usage event, where they are measured.
        costUsd: 0,
        durationMs:
          env2.duration_seconds !== undefined
            ? Math.round(env2.duration_seconds * 1000)
            : Date.now() - started,
        numTurns: env2.num_turns ?? 1,
        assistantTextEvents: text === "" ? 0 : 1,
      });
    });

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancelPoll !== null) clearInterval(cancelPoll);
      reject(err);
    });
  });
}
