/**
 * Smoke test: exercises the compressor without touching the DB or claude-pool.
 * Run with: npx tsx scripts/smoke-thread-compressor.ts
 */
import {
  compressThread,
  emptyCompressorState,
  COMPRESSOR_CONSTANTS,
  type CompressorOptions,
} from "../src/lib/thread-compressor.ts";

type Role = "system" | "user" | "assistant";

interface T {
  role: Role;
  content: string;
  ts: string;
  kind?: string;
}

function fakeTurn(role: Role, idx: number, kb: number): T {
  const body = `Turn ${idx} (${role}) — `.repeat(Math.ceil((kb * 1024) / 24));
  return { role, content: body, ts: new Date().toISOString() };
}

function buildLongThread(turnPairs: number, kbPer: number): T[] {
  const t: T[] = [{ role: "system", content: "SYSTEM PROMPT — never compress this.", ts: "" }];
  for (let i = 1; i <= turnPairs; i++) {
    t.push(fakeTurn("user", i, kbPer));
    t.push(fakeTurn("assistant", i, kbPer));
  }
  return t;
}

async function main() {
  const thread = buildLongThread(40, 1.5);
  const totalCharsBefore = thread.reduce((n, e) => n + e.content.length + 16, 0);
  console.log(`[smoke] thread: ${thread.length} entries, ${totalCharsBefore} chars`);

  const opt: CompressorOptions = {
    thresholdChars: 30_000,
    protectLastN: 6,
    protectFirstN: 2,
    tailRatio: 0.30,
    summaryBudgetChars: 4_000,
    summarize: async (payload) => {
      console.log(`[smoke] summarize invoked with ${payload.length}ch payload`);
      // Verify the structured prompt template made it in.
      if (!payload.includes("Historical Task Snapshot")) {
        throw new Error("Summarizer prompt missing template sections");
      }
      if (!payload.includes("TURNS TO SUMMARIZE:")) {
        throw new Error("Summarizer prompt missing TURNS TO SUMMARIZE marker");
      }
      return "## Historical Task Snapshot\n[fake summary body]\n\n## Goal\nVerify compressor wiring.\n\n## Completed Actions\n1. Built fake thread.";
    },
  };

  const r = await compressThread(thread as any, emptyCompressorState(), opt);

  console.log(`[smoke] compressed=${r.compressed} collapsed=${r.collapsedCount} saved=${r.charsSaved}ch`);
  console.log(`[smoke] new thread length: ${r.thread.length} entries`);

  // Invariants.
  const sys = r.thread[0];
  if (sys.role !== "system" || sys.content.startsWith(COMPRESSOR_CONSTANTS.SUMMARY_PREFIX)) {
    throw new Error("Head[0] should still be the original system prompt");
  }

  const summary = r.thread.find((e) => e.kind === COMPRESSOR_CONSTANTS.SUMMARY_KIND);
  if (!summary) throw new Error("Summary entry not inserted");
  if (!summary.content.includes(COMPRESSOR_CONSTANTS.SUMMARY_PREFIX)) {
    throw new Error("Summary missing prefix wrapper");
  }
  if (!summary.content.includes(COMPRESSOR_CONSTANTS.SUMMARY_END_MARKER)) {
    throw new Error("Summary missing end marker");
  }
  if (!summary.content.includes("[fake summary body]")) {
    throw new Error("Summary body not preserved");
  }

  // Tail invariant: last entry must be the last assistant turn from the original.
  const lastOrig = thread[thread.length - 1];
  const lastNew = r.thread[r.thread.length - 1];
  if (lastNew.content !== lastOrig.content) {
    throw new Error("Tail was modified — should be verbatim");
  }

  // Char saving: must be positive.
  if (r.charsSaved <= 0) throw new Error(`Expected charsSaved > 0, got ${r.charsSaved}`);

  // State updated.
  if (r.state.compressionCount !== 1) throw new Error("compressionCount not bumped");
  if (!r.state.previousSummary) throw new Error("previousSummary not stored");

  // Second pass — should use iterative-update prompt.
  let sawIterativePrompt = false;
  const opt2: CompressorOptions = {
    ...opt,
    summarize: async (payload) => {
      sawIterativePrompt =
        payload.includes("PREVIOUS SUMMARY:") &&
        payload.includes("NEW TURNS TO INCORPORATE:");
      return "## Historical Task Snapshot\n[updated summary]";
    },
  };

  // Append more turns to push back over threshold.
  const more: T[] = [];
  for (let i = 100; i < 130; i++) {
    more.push(fakeTurn("user", i, 1.5));
    more.push(fakeTurn("assistant", i, 1.5));
  }
  const r2 = await compressThread([...r.thread, ...more] as any, r.state, opt2);
  if (!r2.compressed) throw new Error("Second pass did not compress");
  if (!sawIterativePrompt) throw new Error("Second pass did not use iterative-update prompt template");
  if (r2.state.compressionCount !== 2) throw new Error("compressionCount not bumped on 2nd pass");

  // Fallback path — summarizer returns null.
  const opt3: CompressorOptions = {
    ...opt,
    summarize: async () => null,
  };
  const r3 = await compressThread(thread as any, emptyCompressorState(), opt3);
  if (!r3.compressed) throw new Error("Fallback path didn't run compression");
  const fallbackSummary = r3.thread.find((e) => e.kind === COMPRESSOR_CONSTANTS.SUMMARY_KIND);
  if (!fallbackSummary?.content.includes("Auto-extracted")) {
    throw new Error("Fallback summary not used when summarizer returns null");
  }
  if (fallbackSummary.meta?.summarizer_failed !== true) {
    throw new Error("meta.summarizer_failed not set on fallback");
  }

  // No-op path — thread under threshold.
  const small = buildLongThread(2, 0.5);
  const r4 = await compressThread(small as any, emptyCompressorState(), opt);
  if (r4.compressed) throw new Error("Compressor ran on a sub-threshold thread");
  if (r4.thread !== small) throw new Error("Sub-threshold path should return input unchanged");

  console.log("[smoke] all invariants passed ✓");
}

main().catch((e) => {
  console.error("[smoke] FAILED:", e);
  process.exit(1);
});
