/**
 * Gemini quota — the real percentages, read out of `agy`'s own /usage screen.
 *
 * ── THIS SUPERSEDES "GOOGLE PUBLISHES NO DENOMINATOR" ────────────────────────
 * The indicator row's `gem` slot was built as a token TALLY rather than a bar,
 * on round 1302's finding that no readable quota resource exists for a consumer
 * account: the API publishes none, the credits API was switched off for
 * consumers on 2026-06-18, and the only remaining figure lived inside the
 * Antigravity CLI's TUI.
 *
 * That last clause turned out to be the answer rather than the obstacle. `agy`'s
 * `/usage` screen prints exactly what the row wanted:
 *
 *     Weekly Limit Remaining
 *       [████████████████████████████████████] 99.36%
 *       99% remaining · Refreshes in 99h 16m
 *
 * So the denominator does exist — it is just behind a slash command in a
 * terminal UI instead of an HTTP endpoint. This module drives that UI and parses
 * it, and the row can finally render a bar that means something.
 *
 * ── WHY IT IS MANUAL-ONLY ────────────────────────────────────────────────────
 * Konrad, 2026-08-22: "have a refresh button next to it so I manually have to
 * press it, I don't even need it to automatically update."
 *
 * That matches the cost. A reading is not a cheap HTTP GET: it spawns the full
 * Antigravity TUI in a pty, waits for it to paint, sends a slash command, waits
 * again, scrapes, and tears down — about twenty seconds and a real process each
 * time. Polling that on a timer would burn a TUI launch every interval forever
 * to watch a number that moves slowly. So nothing here runs on a schedule: the
 * last reading is cached with its timestamp, and a refresh happens when a human
 * asks for one.
 *
 * ── WHAT IS PARSED, AND WHAT IS DELIBERATELY NOT ─────────────────────────────
 * Only the GEMINI MODELS group. `/usage` also prints a "CLAUDE AND GPT MODELS"
 * group — that is Antigravity's own bundled Claude/GPT allowance, a different
 * subscription from the Claude Code accounts this OS runs on. Rendering it
 * beside our real Claude bars would put two unrelated numbers labelled "Claude"
 * on one row, which is precisely the confusion the single indicator row exists
 * to end. It is parsed into `other_group` so the fact is not lost, and it is not
 * shown.
 */

import { spawn } from "node:child_process";

const TMUX_BIN = "/usr/bin/tmux";
const AGY_BIN = "/root/.local/bin/agy";

export interface GeminiWindowQuota {
  /** Percent REMAINING, as agy states it. 99.36 means 99.36% left. */
  remaining_pct: number;
  /** agy's own words for when it resets, e.g. "99h 16m". Null when absent. */
  refreshes_in: string | null;
}

export interface GeminiQuotaReading {
  ok: boolean;
  /** The signed-in Google account, from agy's own header. */
  account: string | null;
  /** e.g. "Google AI Ultra" — the plan agy reports, not one we assumed. */
  plan: string | null;
  weekly: GeminiWindowQuota | null;
  five_hour: GeminiWindowQuota | null;
  /** The CLAUDE AND GPT group, captured but not rendered. See the header. */
  other_group: { weekly: GeminiWindowQuota | null; five_hour: GeminiWindowQuota | null } | null;
  /** When this reading was taken. Null ⇒ nobody has ever refreshed. */
  read_at: string | null;
  /** Why a reading failed, in words. Null on success. */
  error: string | null;
}

const EMPTY: GeminiQuotaReading = {
  ok: false,
  account: null,
  plan: null,
  weekly: null,
  five_hour: null,
  other_group: null,
  read_at: null,
  error: null,
};

let cached: GeminiQuotaReading = { ...EMPTY };

export function cachedGeminiQuota(): GeminiQuotaReading {
  return cached;
}

function run(bin: string, args: string[], timeoutMs = 20_000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    // stdio[0] must be "ignore": agy reads stdin on its auth path, and a pipe
    // nobody closes never yields EOF.
    const c = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const t = setTimeout(() => c.kill("SIGKILL"), timeoutMs);
    c.stdout.on("data", (d: Buffer) => (out += d.toString()));
    c.stderr.on("data", (d: Buffer) => (out += d.toString()));
    c.on("close", (code) => {
      clearTimeout(t);
      resolve({ code, out });
    });
    c.on("error", () => {
      clearTimeout(t);
      resolve({ code: null, out });
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Parse one "<label> Limit Remaining / [bar] NN.NN% / … Refreshes in X" block.
 *
 * Anchored on the percentage's own line rather than a fixed offset from the
 * label: agy pads and wraps this screen, and a line-offset parser would read a
 * bar as a number the first time the terminal is a different width.
 */
function parseWindow(lines: string[], startIdx: number): GeminiWindowQuota | null {
  for (let i = startIdx; i < Math.min(startIdx + 6, lines.length); i++) {
    const pct = /(\d+(?:\.\d+)?)%/.exec(lines[i]);
    if (pct !== null) {
      let refreshes: string | null = null;
      for (let j = i; j < Math.min(i + 3, lines.length); j++) {
        const r = /Refreshes in ([0-9hm ]+)/.exec(lines[j]);
        if (r !== null) {
          refreshes = r[1].trim();
          break;
        }
      }
      return { remaining_pct: Number(pct[1]), refreshes_in: refreshes };
    }
  }
  return null;
}

/** Pure, so it can be tested against a captured screen without a pty. */
export function parseUsageScreen(screen: string): Omit<GeminiQuotaReading, "read_at"> {
  const lines = screen.split("\n");

  const acct = /Account:\s*(\S+@\S+)/.exec(screen);
  const plan = /\(([^)]*Google AI[^)]*)\)/.exec(screen);

  // Which group a limit belongs to is decided by the most recent group heading
  // ABOVE it. Both groups print identically-worded limits, so a search that
  // ignored the headings would return whichever came first and be wrong half
  // the time.
  let group: "gemini" | "other" | null = null;
  const found = {
    gemini: { weekly: null as GeminiWindowQuota | null, five: null as GeminiWindowQuota | null },
    other: { weekly: null as GeminiWindowQuota | null, five: null as GeminiWindowQuota | null },
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/GEMINI MODELS/.test(l)) group = "gemini";
    else if (/CLAUDE AND GPT MODELS/.test(l)) group = "other";

    if (group === null) continue;
    const bucket = group === "gemini" ? found.gemini : found.other;
    if (/Weekly Limit Remaining/.test(l) && bucket.weekly === null) {
      bucket.weekly = parseWindow(lines, i + 1);
    } else if (/Five Hour Limit Remaining/.test(l) && bucket.five === null) {
      bucket.five = parseWindow(lines, i + 1);
    }
  }

  const ok = found.gemini.weekly !== null || found.gemini.five !== null;
  return {
    ok,
    account: acct?.[1] ?? null,
    plan: plan?.[1] ?? null,
    weekly: found.gemini.weekly,
    five_hour: found.gemini.five,
    other_group:
      found.other.weekly !== null || found.other.five !== null
        ? { weekly: found.other.weekly, five_hour: found.other.five }
        : null,
    error: ok ? null : "agy's /usage screen did not contain a GEMINI MODELS limit.",
  };
}

/**
 * Take a fresh reading by driving the TUI. ~20s. Never called on a timer.
 */
export async function refreshGeminiQuota(): Promise<GeminiQuotaReading> {
  const session = `agy-usage-${Date.now().toString(36)}`;
  const fail = (error: string): GeminiQuotaReading => {
    const r = { ...EMPTY, read_at: new Date().toISOString(), error };
    cached = r;
    return r;
  };

  try {
    await run(TMUX_BIN, ["kill-session", "-t", session]);
    // Width 200 so the bars and percentages are not wrapped mid-number. The
    // login broker learned this the expensive way: this TUI truncates at the
    // pane edge and a cut value still parses.
    const made = await run(TMUX_BIN, [
      "new-session", "-d", "-s", session, "-x", "200", "-y", "60",
      `cd /tmp && ${AGY_BIN}; exec bash`,
    ]);
    if (made.code !== 0) return fail(`could not start a terminal: ${made.out.trim().slice(0, 200)}`);

    // Wait for the TUI to paint before typing; a slash command sent into a
    // half-drawn screen is swallowed.
    let painted = false;
    for (let i = 0; i < 20; i++) {
      await sleep(1000);
      const cap = await run(TMUX_BIN, ["capture-pane", "-p", "-J", "-t", session]);
      if (/for shortcuts|Antigravity CLI/.test(cap.out)) {
        painted = true;
        break;
      }
    }
    if (!painted) return fail("the Antigravity CLI did not finish starting within 20s.");

    /* The TUI SWALLOWS the first keystrokes even after it has painted its
     * frame — observed by hand, and it is what made the first version of this
     * time out: "/usage" went nowhere, and Enter was then pressed on an empty
     * prompt. Painting and accepting input are two different readinesses.
     *
     * So the text is typed and then CONFIRMED on screen before Enter is sent.
     * Sending Enter blind is what turns a swallowed keystroke into a 15-second
     * mystery rather than a retry. */
    let typed = false;
    for (let attempt = 0; attempt < 5 && !typed; attempt++) {
      await run(TMUX_BIN, ["send-keys", "-t", session, "-l", "/usage"]);
      for (let i = 0; i < 4; i++) {
        await sleep(700);
        const cap = await run(TMUX_BIN, ["capture-pane", "-p", "-J", "-t", session]);
        if (/\/usage/.test(cap.out)) {
          typed = true;
          break;
        }
      }
    }
    if (!typed) return fail("the Antigravity CLI never accepted the /usage command.");

    // The slash command opens a completion menu; Enter selects it.
    await sleep(800);
    await run(TMUX_BIN, ["send-keys", "-t", session, "Enter"]);

    for (let i = 0; i < 25; i++) {
      await sleep(1000);
      const cap = await run(TMUX_BIN, ["capture-pane", "-p", "-J", "-t", session]);
      if (/Limit Remaining/.test(cap.out)) {
        const parsed = parseUsageScreen(cap.out);
        const reading: GeminiQuotaReading = { ...parsed, read_at: new Date().toISOString() };
        cached = reading;
        return reading;
      }
    }
    return fail("agy did not render a quota screen within 25s of /usage.");
  } finally {
    await run(TMUX_BIN, ["kill-session", "-t", session]);
  }
}
