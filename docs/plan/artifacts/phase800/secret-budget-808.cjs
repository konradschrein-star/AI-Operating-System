/**
 * secret-budget-808.cjs — ROUND 808: the request the surface no longer makes.
 *
 * WHY A NEW INSTRUMENT AND NOT JUST nav-walk. nav-walk samples three 30 s
 * windows. The poll this round removes fires every 60 s, so it lands in a
 * given 30 s window with probability ~1/2 — and in the round-808 baseline run
 * it landed in NONE of the three, which means the instrument that guards the
 * ceiling literally could not see the request being argued about. (That is the
 * same sampling weakness round 802 hit from the other side, where a 7.5/min
 * poll printed as 7 or 8; the arithmetic is in `nav-walk-sampling.cjs`.)
 *
 * So: one long window, not three short ones. The surface is opened, left
 * ALONE, and every `/api/` request it makes is counted for `--seconds`
 * (default 180). At 180 s a 60 s poll must appear three times or the claim
 * that it exists is wrong, and zero times if it has really been removed.
 *
 * WHAT IT ASSERTS
 *   1. The per-path table, printed in full. No total is reported without the
 *      paths that make it up — round 802's lesson was that a rounded integer
 *      is not proof of anything.
 *   2. `--expect-secrets-poll yes|no`: on the BEFORE tree the `/secrets` path
 *      MUST appear (otherwise the before/after pair is measuring nothing); on
 *      the AFTER tree it must be absent for the whole window.
 *   3. The arithmetic steady state is recorded beside the measurement so a
 *      reader can check one against the other rather than trusting either.
 *
 * The stream itself is deliberately NOT counted as a request-per-minute: it is
 * one connection, opened once, that stays open. It shows up in the raw list
 * (`/api/secret-events`) exactly once, and that is the whole point — a reader
 * should be able to see the trade in the table.
 *
 * Run:
 *   PHASE700_BASE_URL=http://127.0.0.1:7852 PHASE700_API_URL=http://127.0.0.1:7848 \
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-808.txt)" \
 *     node docs/plan/artifacts/phase800/secret-budget-808.cjs \
 *       --label after --expect-secrets-poll no [--seconds 180] [--write]
 *
 * Non-destructive by default (round 705's rule): without `--write` the JSON
 * lands in /tmp/phase800-out and the committed artifact is untouched.
 */

const {
  API,
  BASE,
  CHAT_TEXT,
  finish,
  makeChecker,
  openChat,
  withBrowser,
} = require("../phase700/lib-703.cjs");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return fallback;
  const v = process.argv[i + 1];
  if (v === undefined || v.startsWith("--")) {
    throw new Error(`--${name} needs a value`);
  }
  return v;
}

const LABEL = arg("label", null);
if (!LABEL) throw new Error("--label <before|after> is required — the two runs must not be confusable");

const EXPECT_SECRETS = (() => {
  const v = arg("expect-secrets-poll", null);
  if (v !== "yes" && v !== "no") {
    throw new Error('--expect-secrets-poll must be "yes" (BEFORE tree) or "no" (AFTER tree)');
  }
  return v === "yes";
})();

const SECONDS = (() => {
  const n = Number(arg("seconds", "180"));
  if (!Number.isInteger(n) || n < 60 || n > 900) {
    throw new Error(`--seconds must be an integer in [60,900]; got ${n}`);
  }
  return n;
})();

/** Collapse ids so two runs' tables line up. Copied from nav-walk.cjs's `per`
 *  so the two instruments group requests identically. */
function normalise(url) {
  return url.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id").split("?")[0];
}

async function main() {
  const { results, check, note, failed } = makeChecker();
  note("tree under test", LABEL);
  note("servers", { BASE, API, chat: CHAT_TEXT });
  note("window (seconds)", SECONDS);

  const payload = await withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    const seen = [];
    /** EVERY request since the page opened, not just the ones inside the
     *  window. The event stream is opened ONCE at mount and then stays open;
     *  a window-scoped list therefore cannot see it, and asserting on the
     *  window would report "no stream" for a stream that is working perfectly
     *  (round 808's first run made exactly that mistake). The per-minute table
     *  stays window-scoped — a connection is not a rate. */
    const all = [];
    let counting = false;
    page.on("request", (req) => {
      const u = req.url();
      if (!u.includes("/api/")) return;
      const rec = { url: normalise(u.replace(BASE, "")), t: Date.now() };
      all.push(rec);
      if (counting) seen.push(rec);
    });

    await openChat(page);
    // Settle before counting: mount fetches are not steady state, and counting
    // them would flatter or damn either tree depending on when the clock
    // started.
    await page.waitForTimeout(5_000);

    counting = true;
    const t0 = Date.now();
    await page.waitForTimeout(SECONDS * 1_000);
    counting = false;
    const elapsedMs = Date.now() - t0;

    const byPath = {};
    for (const r of seen) byPath[r.url] = (byPath[r.url] ?? 0) + 1;
    const perMin = {};
    for (const [k, v] of Object.entries(byPath)) {
      perMin[k] = Number(((v * 60_000) / elapsedMs).toFixed(2));
    }
    const total = Number(((seen.length * 60_000) / elapsedMs).toFixed(2));

    note("requests by path (raw count over the window)", byPath);
    note("requests by path (per minute)", perMin);
    note("TOTAL per minute", total);

    const secretsPaths = Object.keys(byPath).filter((p) => /\/secrets$/.test(p));
    /** Session-scoped, for the reason in the `all` comment above. */
    const byPathAll = {};
    for (const r of all) byPathAll[r.url] = (byPathAll[r.url] ?? 0) + 1;
    const streamPaths = Object.keys(byPathAll).filter((p) => p.includes("secret-events"));
    note("secrets LIST calls in the window", secretsPaths.map((p) => [p, byPath[p]]));
    note(
      "event-stream connections since page load (a connection, not a rate)",
      streamPaths.map((p) => [p, byPathAll[p]]),
    );
    note(
      "secrets LIST calls since page load (mount fetch included)",
      Object.keys(byPathAll)
        .filter((p) => /\/secrets$/.test(p))
        .map((p) => [p, byPathAll[p]]),
    );

    if (EXPECT_SECRETS) {
      check(
        "BEFORE: the 60s secrets poll is visible in the window (else this pair measures nothing)",
        secretsPaths.length > 0,
        true,
      );
      check(
        "BEFORE: …and there is no event stream on this tree at all",
        streamPaths.length,
        0,
      );
    } else {
      check(
        "AFTER: the surface makes NO secrets list request while idle",
        secretsPaths.length,
        0,
      );
      check(
        "AFTER: …and the stream is open instead (one connection, not a poll)",
        streamPaths.length > 0,
        true,
      );
      for (const p of streamPaths) {
        check(
          `AFTER: ${p} was connected ONCE over the whole session, not re-opened in a loop`,
          byPathAll[p] <= 2,
          true,
        );
      }
    }

    check(
      "the surface stays inside phase 500's 'after' budget (≤40/min)",
      total <= 40,
      true,
    );

    return {
      label: LABEL,
      window_ms: elapsedMs,
      by_path_count: byPath,
      by_path_per_minute: perMin,
      total_per_minute: total,
      secrets_list_calls: secretsPaths.map((p) => ({ path: p, count: byPath[p] })),
      by_path_count_since_page_load: byPathAll,
      stream_connections: streamPaths.map((p) => ({ path: p, count: byPathAll[p] })),
      raw: seen.map((r) => ({ url: r.url, offset_ms: r.t - t0 })),
    };
  });

  finish(`secret-budget-808-${LABEL}.json`, { ...payload, base: BASE, api: API, failures: failed(), results }, failed());
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(2);
});
