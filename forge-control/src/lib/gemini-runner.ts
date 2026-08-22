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

import { spawn } from "node:child_process";

import type { CcEvent, CcResult } from "./cc-runner.ts";
import { recordSpend } from "../db/spend.ts";

/** Absolute. pm2's PATH has no /root/.local/bin — that export lives in
 *  `.bashrc`, which pm2 never sources — so a bare `spawn("agy")` is ENOENT
 *  under the server and works perfectly over SSH. */
export const AGY_BIN = "/root/.local/bin/agy";

/** The only Gemini model this OS runs. Konrad, 2026-08-22: "We'll always use
 *  gemini-3.7-flash-high." */
export const GEMINI_MODEL = "gemini-3.7-flash-high";

export const GEMINI_MODEL_PREFIX = "gemini-";

/** Does this model id belong to the Gemini engine rather than Claude? */
export function isGeminiModel(model: string | null | undefined): boolean {
  return typeof model === "string" && model.startsWith(GEMINI_MODEL_PREFIX);
}

/** agy's JSON envelope for `--output-format json`. Verified live. */
interface AgyEnvelope {
  conversation_id?: string;
  status?: string;
  response?: string;
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
  onEvent?: (e: CcEvent) => void;
  isCancelled?: () => Promise<boolean>;
}

const DEFAULT_TIMEOUT_MS = 900_000;

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

  const args = [
    "-p", prompt,
    "--model", model,
    "--output-format", "json",
    // Non-interactive by construction: there is no human at this terminal to
    // approve a tool call, so an approval prompt is a hang, not a safeguard.
    "--dangerously-skip-permissions",
    // The whole point — see the header.
    "--add-dir", opts.cwd,
  ];
  for (const d of opts.addDirs ?? []) args.push("--add-dir", d);
  if (opts.sessionId) args.push("--conversation", opts.sessionId);

  const env = { ...process.env };
  // A stray key would silently move this run off the subscription and onto
  // metered billing — the failure mode is an invoice, not an error.
  delete env.GEMINI_API_KEY;
  delete env.GOOGLE_API_KEY;

  return await new Promise<CcResult>((resolve, reject) => {
    const child = spawn(AGY_BIN, args, {
      cwd: opts.cwd,
      env,
      // stdin MUST be ignored. agy's auth path reads stdin, and a pipe nobody
      // writes to never yields EOF — measured: the process was still running at
      // 12s with a pipe, and answered in 372ms with /dev/null.
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(new Error(`agy exceeded ${opts.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`));
      }
    }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    const cancelPoll = opts.isCancelled
      ? setInterval(() => {
          void opts.isCancelled!().then((c) => {
            if (c && !settled) {
              settled = true;
              clearTimeout(timer);
              child.kill("SIGKILL");
              reject(new Error("cancelled"));
            }
          });
        }, 5000)
      : null;

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });

    // `close`, not `exit`: exit can fire before the last stdout chunk is read,
    // which would truncate the very JSON the result is parsed from.
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (cancelPoll !== null) clearInterval(cancelPoll);

      let env2: AgyEnvelope | null = null;
      const trimmed = stdout.trim();
      if (trimmed !== "") {
        try {
          env2 = JSON.parse(trimmed) as AgyEnvelope;
        } catch {
          // agy prints progress lines before the envelope in some modes; take
          // the last balanced object rather than giving up on the whole run.
          const last = trimmed.lastIndexOf("{");
          if (last >= 0) {
            try {
              env2 = JSON.parse(trimmed.slice(last)) as AgyEnvelope;
            } catch {
              env2 = null;
            }
          }
        }
      }

      if (env2 === null) {
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
        reject(
          new Error(
            `agy returned status ${env2.status} with no response text.` +
              (stderr.trim() ? ` STDERR: ${stderr.trim().slice(0, 400)}` : ""),
          ),
        );
        return;
      }



      const usageIn = numOr0(env2.usage?.input_tokens);
      const usageOut = numOr0(env2.usage?.output_tokens);

      /* ── Feed the indicator row ────────────────────────────────────────────
       * `GET /api/usage/quota` builds the `gem` tally from spend_log rows where
       * provider ILIKE 'gemini%', summing `units`. Nothing else writes them, so
       * without this the row would say "0 calls" forever while Gemini did the
       * work — a false statement, and exactly the kind that row was built to
       * avoid.
       *
       * amount_eur is 0.0 and MEANS zero: this is a flat Google AI Pro
       * subscription, so there is no marginal euro to record. The tokens are
       * the real reading, and they go in `units`.
       *
       * Awaited-but-tolerant: a spend-log failure must not fail a run whose
       * work is already done and whose text is already in hand. */
      void recordSpend([
        {
          provider: "gemini",
          kind: "llm_input",
          amount_eur: 0,
          units: usageIn,
          meta: { model, conversation_id: env2.conversation_id ?? null, engine: "agy" },
        },
        {
          provider: "gemini",
          kind: "llm_output",
          amount_eur: 0,
          units: usageOut,
          meta: {
            model,
            conversation_id: env2.conversation_id ?? null,
            engine: "agy",
            thinking_tokens: numOr0(env2.usage?.thinking_tokens),
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
            input_tokens: usageIn,
            output_tokens: usageOut,
            // agy reports `cache_read_tokens`; the Claude shape calls it
            // cache_read_input_tokens. Mapped rather than dropped so the
            // usage ledger sums one number across both engines.
            cache_read_input_tokens: numOr0(env2.usage?.cache_read_tokens),
            // agy has no cache-creation counter. 0 is honest here: the field
            // exists in the shared shape and this engine never populates it.
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
