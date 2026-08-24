/**
 * depth-poll-r4.cjs — the browser measurement for `aios-console-responsiveness`.
 *
 * WHY THIS EXISTS. Round 3 reported the chat surface's request budget as
 * ARITHMETIC — poll periods divided into 60 — and its reviewer's finding 2 said
 * so: "no actual live/browser measurement was taken despite the brief's METHOD
 * section calling for one". Arithmetic cannot see a poll that keeps running
 * when its panel is hidden, a retry storm, a request nobody counted, or a
 * transcript query that DOUBLES when you drill into a worker. This counts real
 * requests made by a real Chrome against a real build of this branch.
 *
 * WHY NOT `phase600/nav-walk.cjs`, which measures the same three depths.
 * It was run first, and it walks the stack correctly against this build (every
 * identity and panel-state assertion passed — /tmp/r4-navwalk.log). It then
 * dies before its poll windows at `page.reload({ waitUntil: "networkidle" })`:
 * through the `serve-v3-7798.ts` harness the SSE pass-through is BUFFERED by
 * design ("the buffered writer cannot stream SSE", that file's own header), so
 * the reloaded page holds an EventSource that never delivers and never closes,
 * and `networkidle` can never fire. That is a property of the harness, not of
 * this branch — nothing here changed a reload path — but it means the phase-600
 * instrument cannot reach its own windows through it. Rather than edit a gate
 * to make it agree with me, this file measures the three windows directly, out
 * of the SAME shared setup (`phase600/lib-604.cjs` — same browser, same cookie,
 * same chat-opening idiom), and `network-700.cjs`'s verdict is recorded beside
 * it as the second, independent instrument.
 *
 * WHAT IT MEASURES, three 60s windows in ONE page session:
 *   at rest     the manager chat, panel open, Team tab — ChatSurface's own
 *               transcript query is the one polling.
 *   depth 1     drilled into a worker. ChatSurface DISABLES its detail query
 *               (`navStack.length === 0`) and AgentChatView runs one in its
 *               place. Round 3 left those two on different periods — 4s and 3s
 *               — so this window was 5 req/min more expensive than the number
 *               the project was reporting. That is the regression this file
 *               exists to be able to see.
 *   depth 2     drilled again, into a sub-agent.
 *
 * Windows are 60s, not phase 600's 30s doubled: a 30s window samples a 20s poll
 * once or twice by luck of phase, and this round has to compare depths to each
 * other rather than to a fixed cap.
 *
 * BYTES, not just counts. Every `/api/proxy/` response's wire size is summed
 * per window, so the KNOWN LEAD ("a long manager chat re-downloads its whole
 * history several times a minute") has a browser-measured after-number and not
 * only a curl one.
 *
 * SSE: aborted by default (`ABORT_SSE=0` to keep it), matching every network
 * baseline in this corpus. Stream down is the DEGRADED path — the expensive one
 * this project tuned — and it is also the only one a buffered harness can
 * honestly present.
 *
 * Run (README.md in this directory has the full recipe):
 *   PHASE600_BASE_URL=http://127.0.0.1:7810 PHASE600_API_URL=http://127.0.0.1:7812 \
 *   PHASE600_CHAT="okay this is a gigantic task" \
 *   FORGE_SESSION_COOKIE="$(cat /tmp/r4-cookie.txt)" \
 *   PHASE600_OUT_DIR=/tmp/r4-depth node docs/plan/aios-console-responsiveness/depth-poll-r4.cjs
 */

const fs = require("node:fs");
const path = require("node:path");
const {
  BASE,
  CHAT_TEXT,
  makeChecker,
  openChat,
  surfaceState,
  withBrowser,
} = require("../artifacts/phase600/lib-604.cjs");

const { results, check, note, failed } = makeChecker();

const SECONDS = Number(process.env.R4_WATCH_SECONDS ?? "60");
const ABORT_SSE = process.env.ABORT_SSE !== "0";

/** The committed ceiling, in requests per minute, with every panel open —
 *  phase 600 `nav-walk.cjs:310` (P3). A LITERAL here on purpose: this file is a
 *  `.cjs` and cannot import the TypeScript constant, and a measurement that
 *  imported its own ceiling from the build would move with it. The live
 *  constant (`CHAT_SURFACE_REQ_PER_MIN_CEILING`) is pinned to this same 40 by
 *  `scripts/checks/check-chat-delta.ts` §5a, which is where drift goes red. */
const CEILING_PER_MIN = 40;

/** Where a rerun writes. Same rule as every protocol in this corpus: /tmp by
 *  default so following the README cannot overwrite the record being read. */
const SRC_DIR = __dirname;
const OUT_DIR =
  process.env.PHASE600_OUT_DIR ??
  (process.argv.includes("--write") ? SRC_DIR : "/tmp/r4-depth-out");
fs.mkdirSync(OUT_DIR, { recursive: true });

/** `/chat/<uuid>/team` → `/chat/:id/team`, so counts group by endpoint. */
const endpointOf = (rest) =>
  rest.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, ":id").split("?")[0];

async function main() {
  await withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    if (ABORT_SSE) await page.route("**/api/events/**", (route) => route.abort());

    /** Every proxied request, with the size of its response BODY.
     *
     *  `content-length` was the first thing tried here and it is INERT against
     *  this server: Next streams these responses chunked, so the header is
     *  absent and every window reported `bytes: 0` with a green verdict — a
     *  measurement that cannot fail. `response.body()` is the decoded body the
     *  page actually parsed, which is the number this project is about (JSON
     *  the client re-downloads and re-parses); the wire is smaller because the
     *  proxy gzips, and `content_length` is still recorded beside it whenever
     *  the server does send one.
     *
     *  A body that cannot be read (aborted, or the page navigated away before
     *  it arrived) is recorded as `null`, never as 0 — that is the difference
     *  between "no bytes" and "not measured", and a run that silently turned
     *  the second into the first is what this comment exists to prevent. The
     *  per-window count of nulls is in the verdict. */
    let counting = null;
    const pending = [];
    page.on("request", (r) => {
      const url = r.url();
      if (!url.includes("/api/proxy/")) return;
      if (counting === null) return;
      const rest = url.split("/api/proxy")[1];
      counting.push({ endpoint: endpointOf(rest), method: r.method(), bytes: null, req: r });
    });
    page.on("response", (res) => {
      const row = counting === null ? undefined : counting.find((c) => c.req === res.request());
      if (!row) return;
      const len = res.headers()["content-length"];
      row.content_length = len === undefined ? null : Number(len);
      pending.push(
        res
          .body()
          .then((b) => {
            row.bytes = b.byteLength;
          })
          .catch(() => {
            row.bytes = null;
          }),
      );
    });

    await openChat(page, CHAT_TEXT);
    const d0 = await surfaceState(page);
    check("the team tree is ready", d0.teamState, "ready");
    check("nothing is drilled yet", d0.depth, 0);
    note("team rows", d0.teamRows.length);

    /* The worker to click: one that owns a depth-2 sub-agent, so the same walk
     * reaches both levels. Copied from nav-walk.cjs's own selection. */
    const target = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("[data-team-row]"));
      const subIdx = rows.findIndex(
        (r) => r.getAttribute("data-kind") === "subagent" && r.getAttribute("data-depth") === "2",
      );
      if (subIdx < 0) return null;
      for (let i = subIdx - 1; i >= 0; i--) {
        if (rows[i].getAttribute("data-kind") === "worker")
          return {
            worker: rows[i].getAttribute("data-node-id"),
            sub: rows[subIdx].getAttribute("data-node-id"),
          };
      }
      return null;
    });
    if (target === null)
      throw new Error(
        `NO-DEPTH-2-SUBAGENT — no worker in "${CHAT_TEXT}"'s tree owns a sub-agent, so the depth-2 window has nothing to measure. Not a pass.`,
      );
    note("target worker / sub-agent", target);

    const windowOf = async (label) => {
      counting = [];
      pending.length = 0;
      await page.waitForTimeout(SECONDS * 1000);
      const seen = counting.slice();
      counting = null;
      /* Bodies are read asynchronously, so the window has to wait for the ones
       * it started before it can add them up. Without this the last poll of
       * every window counted as 0 bytes. */
      await Promise.all(pending);
      const byEndpoint = {};
      const bytesByEndpoint = {};
      for (const r of seen) {
        byEndpoint[r.endpoint] = (byEndpoint[r.endpoint] ?? 0) + 1;
        bytesByEndpoint[r.endpoint] = (bytesByEndpoint[r.endpoint] ?? 0) + (r.bytes ?? 0);
      }
      const scale = 60 / SECONDS;
      const perMin = Object.fromEntries(
        Object.entries(byEndpoint).map(([k, v]) => [k, Math.round(v * scale * 100) / 100]),
      );
      const totalBytes = seen.reduce((a, r) => a + (r.bytes ?? 0), 0);
      const unmeasured = seen.filter((r) => r.bytes === null).length;
      note(`${label}: requests/min`, { ...perMin, TOTAL: Math.round(seen.length * scale * 100) / 100 });
      note(`${label}: body bytes/min`, {
        total: Math.round(totalBytes * scale),
        chat_detail: Math.round((bytesByEndpoint["/chat/:id"] ?? 0) * scale),
        responses_not_measured: unmeasured,
      });
      return {
        label,
        window_seconds: SECONDS,
        requests: seen.length,
        total_per_minute: Math.round(seen.length * scale * 100) / 100,
        per_minute: perMin,
        body_bytes_per_minute: Math.round(totalBytes * scale),
        chat_detail_body_bytes_per_minute: Math.round((bytesByEndpoint["/chat/:id"] ?? 0) * scale),
        responses_not_measured: unmeasured,
      };
    };

    const wRest = await windowOf("at rest (manager chat)");

    await page.locator(`[data-team-row][data-node-id="${target.worker}"]`).click();
    await page.waitForSelector("[data-agent-chat-view]", { timeout: 30_000 });
    await page.waitForTimeout(2_000);
    const d1 = await surfaceState(page);
    check("depth 1 is open", d1.depth, 1);
    const wD1 = await windowOf("drilled, depth 1 (worker)");

    await page.locator(`[data-team-row][data-node-id="${target.sub}"]`).click();
    await page.waitForTimeout(2_000);
    const d2 = await surfaceState(page);
    check("depth 2 is open", d2.depth, 2);
    const wD2 = await windowOf("drilled, depth 2 (sub-agent)");

    /* ── The assertions ──────────────────────────────────────────────────
     * P3 is phase 600's ceiling, applied to all three windows. P1/P2 are the
     * finding this round fixed: drilling in swaps one transcript query for
     * another, so the total must not RISE. `+1` of slack for a window boundary
     * landing mid-period, the same tolerance nav-walk.cjs uses and for the same
     * reason — a 4s poll lands 15 or 16 times in 60s depending on phase. */
    for (const w of [wRest, wD1, wD2])
      check(`P3 ${w.label}: total <= ${CEILING_PER_MIN}/min`, w.total_per_minute <= CEILING_PER_MIN, true);

    /* THE INSTRUMENT'S OWN CONTROL. The first version of this file summed
     * `content-length`, which this server never sends — so it reported 0 bytes
     * per window and passed. A byte column that can only ever read 0 is worse
     * than no byte column, because it looks like evidence. These two assertions
     * are what makes a repeat of that a FAILURE rather than a quiet zero. */
    check("the byte instrument measured something at rest", wRest.body_bytes_per_minute > 0, true);
    for (const w of [wRest, wD1, wD2])
      check(`${w.label}: every response was measured`, w.responses_not_measured, 0);
    check(
      "P1 drilling to depth 1 does not raise the request total",
      wD1.total_per_minute <= wRest.total_per_minute + 1,
      true,
    );
    check(
      "P2 drilling to depth 2 does not raise it either",
      wD2.total_per_minute <= wRest.total_per_minute + 1,
      true,
    );

    const payload = {
      protocol: "depth-poll-r4.cjs",
      project: "aios-console-responsiveness",
      base: BASE,
      chat: CHAT_TEXT,
      sse: ABORT_SSE ? "aborted (transcript query on its 4s fallback)" : "live",
      ceiling_per_minute: CEILING_PER_MIN,
      windows: { at_rest: wRest, depth_1: wD1, depth_2: wD2 },
      checks: results,
    };
    const out = path.join(OUT_DIR, "depth-poll-r4.json");
    fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
    console.log(`\n${failed() === 0 ? "ALL PASS" : `${failed()} FAILURE(S)`} → ${out}`);
    if (OUT_DIR !== SRC_DIR)
      console.log(`      committed copy untouched; re-record in place with --write`);
    process.exitCode = failed() === 0 ? 0 : 1;
  });
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(1);
});
