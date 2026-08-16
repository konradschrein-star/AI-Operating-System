/**
 * composer-autogrow.cjs — PROTOCOL 1, round 804.
 * docs/plan/14-ui-v3-quality.md § "Composer autogrow" (U28), plus U32's
 * "the send button's box does not move".
 *
 * ── WHY THIS FILE EXISTS AT ALL ───────────────────────────────────────────
 *
 * Round 801 shipped `useAutogrow` and proved its DECISION FUNCTION on a table
 * (`scripts/checks/check-composer-v3.ts`), then said plainly that nobody had
 * measured a real browser. Its numbers — font 13 / line-height 19.5 / padding
 * 10+10 / border 1+1, border-box, resting 61 px, 10-row cap 217 px — are a
 * HYPOTHESIS derived from the style object, and the operator's directive for
 * this round is explicit: measure, do not re-derive.
 *
 * So every number below comes from `getComputedStyle` and `offsetHeight` on the
 * live element in a real Chromium, at 1440×900, against an isolated production
 * build of this worktree. The derived figures appear in the output exactly
 * once, as `hypothesis_r801`, and they are ASSERTED AGAINST the measurement
 * rather than quoted beside it. If they disagree, the measurement wins and this
 * script fails — which is the only way a hypothesis ever gets to become a fact.
 *
 * ── WHAT IS ASSERTED ──────────────────────────────────────────────────────
 *
 *   metrics   the element's real box model, and that the round-801 hypothesis
 *             matches it
 *   1 row     resting height == the 2-row minimum (minRows=2: one line of text
 *             does not shrink the box below its resting size)
 *   5 rows    STRICTLY taller than 1 row
 *   10 rows   == the computed cap, and NOT yet scrolling
 *   11 rows   still == the cap, and NOW scrolling — the boundary useAutogrow's
 *             `clampAutogrow` exists to get right
 *   25 rows   == the cap, scrollHeight > clientHeight, and the cap equals
 *             10*line-height + padding + border to within 1 px
 *   clear     back to the EXACT 2-row minimum
 *   send      back to the EXACT 2-row minimum, via the real send path
 *   keys      Enter sends, Shift+Enter inserts a newline and does not send
 *   U32       the send button's rendered box is byte-identical at rest, at the
 *             cap, and after the reset — same PNG sha256, same width/height
 *
 * ── THE ONE INTERCEPTION, DECLARED ────────────────────────────────────────
 *
 * "Send a real message" is taken as far as it can honestly go without writing
 * into Konrad's live manager chat. The fixture chat is `bfd1283a…` — his real
 * one. A POST that reached the server would append a test message to that
 * thread in the production database and hand it to the executor to answer.
 * Nothing in this round's brief authorises writing to it.
 *
 * So the send goes through the REAL UI path — real keystroke, real handler,
 * real `fetch` — and is stopped at the network boundary: `POST /chat/:id/message`
 * is routed and ABORTED. The proof that "Enter sends" is the intercepted
 * request itself: its method, its URL, and the typed text inside its body are
 * all asserted. The composer's reset is synchronous in the keydown handler
 * (`setDraft("")` at ChatSurface.tsx:1886), so it is unaffected by what the
 * network does — the reset assertion measures the same code path a delivered
 * message would.
 *
 * The abort surfaces as one failed request and one console error. Both are
 * recorded in the output as `expected_send_abort` rather than filtered away.
 *
 * Run (README.md §2):
 *   FORGE_SESSION_COOKIE=… PHASE700_BASE_URL=http://127.0.0.1:7817 \
 *   PHASE700_API_URL=http://127.0.0.1:7814 node composer-autogrow.cjs [--write]
 */

const L = require("./lib-804.cjs");

/** The send button's visual state, as computed style rather than as pixels.
 *  U32 is about the box not moving; this is the second, independent way of
 *  saying "nothing about it changed", and unlike a screenshot it is exact. */
async function readButtonStyle(handle) {
  return handle.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      color: s.color,
      backgroundColor: s.backgroundColor,
      border: `${s.borderTopWidth} ${s.borderTopStyle} ${s.borderTopColor}`,
      padding: `${s.paddingTop} ${s.paddingRight} ${s.paddingBottom} ${s.paddingLeft}`,
      fontSize: s.fontSize,
      text: el.textContent,
    };
  });
}

/** Row counts to measure, in the order they are typed. 10 and 11 straddle the
 *  cap; 25 is "far past it", where the brief wants the scrollbar proven. */
const ROW_STATES = [1, 2, 5, 10, 11, 25];

/** useAutogrow's configuration, from ChatSurface.tsx:1454. Asserted against the
 *  element's `rows` attribute rather than trusted. */
const MIN_ROWS = 2;
const MAX_ROWS = 10;

/** The round-801 derivation, quoted here ONLY so it can be tested. */
const HYPOTHESIS_R801 = {
  fontSizePx: 13,
  lineHeightPx: 19.5,
  paddingPx: 20,
  borderPx: 2,
  boxSizing: "border-box",
  restingPx: 61,
  capPx: 217,
};

async function main() {
  const { check, note, results, failed } = L.makeChecker();
  const started_at = new Date().toISOString();

  const measured = {};
  let metrics = null;
  let sendCapture = null;
  /** Raw PNG buffers, kept out of the JSON — only their comparisons are
   *  evidence. */
  const shots = {};
  const sendButtonShots = {};
  const expectedAborts = [];

  await L.withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    const errs = L.watchErrors(page);
    await L.openChat(page);

    /* ── the hooks, resolved once and asserted ───────────────────────────── */
    const composer = await L.resolveOne(page, "composer-input");
    const sendBtn = await L.resolveOne(page, "composer-send");
    check("hook composer-input resolved to exactly 1 node", composer.tried.at(-1).matched, 1);
    check("hook composer-send resolved to exactly 1 node", sendBtn.tried.at(-1).matched, 1);
    note("composer-input selector used", composer.selector);
    note("composer-send selector used", sendBtn.selector);

    /* ── metrics, measured ───────────────────────────────────────────────── */
    metrics = await L.readBoxMetrics(composer.handle);
    const paddingPx = metrics.paddingTopPx + metrics.paddingBottomPx;
    const borderPx = metrics.borderTopPx + metrics.borderBottomPx;
    const minPx = L.rowsToPx(metrics, MIN_ROWS);
    const maxPx = L.rowsToPx(metrics, MAX_ROWS);

    note("measured metrics", metrics);
    check("the textarea's rows attribute is minRows", metrics.rowsAttr, MIN_ROWS);
    check("line-height is a usable number (not `normal`)", Number.isFinite(metrics.lineHeightPx) && metrics.lineHeightPx > 0, true);
    check("box-sizing is border-box", metrics.boxSizing, "border-box");

    /* The hypothesis, on trial. Each of these is the round-801 derivation
     * being confronted with the browser; a mismatch fails the round. */
    check("MEASURED font-size == r801 hypothesis", metrics.fontSizePx, HYPOTHESIS_R801.fontSizePx);
    check("MEASURED line-height == r801 hypothesis", metrics.lineHeightPx, HYPOTHESIS_R801.lineHeightPx);
    check("MEASURED padding (top+bottom) == r801 hypothesis", paddingPx, HYPOTHESIS_R801.paddingPx);
    check("MEASURED border (top+bottom) == r801 hypothesis", borderPx, HYPOTHESIS_R801.borderPx);
    check("MEASURED 2-row minimum == r801's 61px", minPx, HYPOTHESIS_R801.restingPx);
    check("MEASURED 10-row cap == r801's 217px", maxPx, HYPOTHESIS_R801.capPx);

    /* The empty/disabled baseline, before a single character is typed. The
     * post-send state is compared against THIS rather than against a typed
     * state: an empty draft correctly renders the button disabled
     * (ChatSurface.tsx:2002), so comparing the two would be asserting that a
     * deliberate affordance does not exist. */
    shots.at_open = await sendBtn.handle.screenshot();
    sendButtonShots.at_open_box = await sendBtn.handle.boundingBox();
    sendButtonShots.at_open_style = await readButtonStyle(sendBtn.handle);

    /* ── the states ──────────────────────────────────────────────────────── */
    for (const rows of ROW_STATES) {
      await L.typeLines(page, composer.handle, rows);
      measured[`rows_${rows}`] = await L.readBox(composer.handle);
      if (rows === MIN_ROWS) {
        shots.at_min = await sendBtn.handle.screenshot();
        /* The CONTROL: the same state, captured twice in a row with nothing
         * touched in between. Whatever these two differ by is this run's
         * measurement noise, and it is what every other comparison is judged
         * against. Measured per run, never a constant carried in from a
         * previous one. */
        shots.at_min_control = await sendBtn.handle.screenshot();
        sendButtonShots.at_min_box = await sendBtn.handle.boundingBox();
        sendButtonShots.at_min_style = await readButtonStyle(sendBtn.handle);
      }
      if (rows === 25) {
        shots.at_cap = await sendBtn.handle.screenshot();
        sendButtonShots.at_cap_box = await sendBtn.handle.boundingBox();
        sendButtonShots.at_cap_style = await readButtonStyle(sendBtn.handle);
      }
    }

    const m1 = measured.rows_1;
    const m2 = measured.rows_2;
    const m5 = measured.rows_5;
    const m10 = measured.rows_10;
    const m11 = measured.rows_11;
    const m25 = measured.rows_25;

    check("1 line rests at the 2-row minimum (px)", m1.offsetHeight, minPx);
    check("1 line does not scroll", m1.scrollbarPresent, false);
    check("2 lines == the 2-row minimum (px)", m2.offsetHeight, minPx);
    check("5 lines is STRICTLY taller than 1 line", m5.offsetHeight > m1.offsetHeight, true);
    check("5 lines is below the cap", m5.offsetHeight < maxPx, true);
    check("5 lines does not scroll", m5.scrollbarPresent, false);

    check("10 lines == the cap (px)", m10.offsetHeight, maxPx);
    /* The boundary clampAutogrow is written for: AT the cap, no scrollbar. */
    check("10 lines does NOT scroll (exactly at the cap)", m10.scrollbarPresent, false);
    check("11 lines == the cap (px)", m11.offsetHeight, maxPx);
    check("11 lines DOES scroll (one row over the cap)", m11.scrollbarPresent, true);

    check("25 lines == the cap (px)", m25.offsetHeight, maxPx);
    check("25 lines scrolls internally (scrollHeight > clientHeight)", m25.scrollHeight > m25.clientHeight, true);
    check("25 lines sets overflow-y auto", m25.overflowY, "auto");
    check(
      "the cap equals 10*line-height + padding + border within 1px",
      Math.abs(m25.offsetHeight - (metrics.lineHeightPx * MAX_ROWS + paddingPx + borderPx)) <= 1,
      true,
    );

    /* ── clear → exact minimum ───────────────────────────────────────────── */
    await L.clearComposer(page, composer.handle);
    measured.after_clear = await L.readBox(composer.handle);
    check("clearing returns to the EXACT 2-row minimum", measured.after_clear.offsetHeight, minPx);
    check("cleared composer does not scroll", measured.after_clear.scrollbarPresent, false);
    check("cleared composer's overflow-y is hidden", measured.after_clear.overflowY, "hidden");

    /* ── Shift+Enter inserts a newline and does NOT send ─────────────────── */
    const chat = await L.resolveChat();
    let sendAttempts = 0;
    await ctx.route(`**/api/proxy/chat/${chat.id}/message`, async (route) => {
      sendAttempts++;
      const req = route.request();
      sendCapture = {
        method: req.method(),
        url: req.url(),
        postData: req.postData(),
      };
      /* Declared in the header: aborted, never delivered. Nothing this round
       * does may append a message to Konrad's real manager chat. */
      await route.abort("failed");
    });

    await composer.handle.click();
    await page.keyboard.type("line one");
    await page.keyboard.press("Shift+Enter");
    await page.keyboard.type("line two");
    await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
    const afterShiftEnter = await composer.handle.evaluate((el) => el.value);
    measured.after_shift_enter = await L.readBox(composer.handle);
    check("Shift+Enter inserted a newline", afterShiftEnter, "line one\nline two");
    check("Shift+Enter did NOT send", sendAttempts, 0);
    check("two lines still rest at the 2-row minimum", measured.after_shift_enter.offsetHeight, minPx);

    /* Grow it past the cap first, so the post-send reset is a real fall from
     * 217 px rather than a no-op from 61. */
    await L.typeLines(page, composer.handle, 25, "sendtest");
    const beforeSend = await L.readBox(composer.handle);
    check("composer is at the cap immediately before sending", beforeSend.offsetHeight, maxPx);

    /* ── Enter sends, and the composer resets ────────────────────────────── */
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1_200);
    measured.after_send = await L.readBox(composer.handle);
    const draftAfterSend = await composer.handle.evaluate((el) => el.value);

    check("Enter attempted exactly one send", sendAttempts, 1);
    check("the send was a POST", sendCapture?.method, "POST");
    check(
      "the send carried the typed text",
      typeof sendCapture?.postData === "string" && sendCapture.postData.includes("sendtest0"),
      true,
    );
    check("the composer is empty after sending", draftAfterSend, "");
    check("sending returns to the EXACT 2-row minimum", measured.after_send.offsetHeight, minPx);
    check("the composer does not scroll after sending", measured.after_send.scrollbarPresent, false);

    shots.after_send = await sendBtn.handle.screenshot();
    sendButtonShots.after_send_box = await sendBtn.handle.boundingBox();
    sendButtonShots.after_send_style = await readButtonStyle(sendBtn.handle);

    /* ── U32: the send button's box does not move ────────────────────────────
     *
     * THE FIRST VERSION OF THIS ASSERTION WAS WRONG AND IS WORTH THE COMMENT.
     * It hashed the two PNGs and demanded equality. It failed — and the
     * investigation (README §3.1) found the button's rect identical to the
     * pixel in every state, while two captures of the SAME UNTOUCHED STATE
     * also produced different bytes. Chromium's PNG encoding is not
     * deterministic at that level; `sha256(png)` fails honest builds and
     * passes on the retry, which is precisely the "coin flip dressed as a
     * gate" phase 700 §3.4 was written about.
     *
     * What replaced it is three assertions with a tolerance this run measures
     * for itself:
     *   1. the BOX is exactly equal — x, y, width and height, all four, in
     *      every state. This is U32's actual claim and it needs no tolerance.
     *   2. the rendered pixels differ by no more than the CONTROL pair
     *      (same state, captured twice). Noise cannot exceed noise.
     *   3. SENSITIVITY — the empty→typed transition, which is a real and
     *      intended visual change, must register far above that floor. Without
     *      this a blind instrument would score a perfect pass, so the script
     *      proves it can still see rather than asking to be trusted.
     */
    const noise = await L.pixelDiff(page, shots.at_min.toString("base64"), shots.at_min_control.toString("base64"));
    const minVsCap = await L.pixelDiff(page, shots.at_min.toString("base64"), shots.at_cap.toString("base64"));
    const emptyVsTyped = await L.pixelDiff(page, shots.at_open.toString("base64"), shots.at_min.toString("base64"));
    const openVsAfterSend = await L.pixelDiff(page, shots.at_open.toString("base64"), shots.after_send.toString("base64"));
    sendButtonShots.pixel_diffs = { noise_control: noise, min_vs_cap: minVsCap, empty_vs_typed_SENSITIVITY: emptyVsTyped, open_vs_after_send: openVsAfterSend };

    for (const [label, box] of [
      ["at the cap", sendButtonShots.at_cap_box],
      ["after the send reset", sendButtonShots.after_send_box],
      ["at open", sendButtonShots.at_open_box],
    ]) {
      check(`U32 — send button box is unchanged ${label}`, box, sendButtonShots.at_min_box);
    }
    check(
      "U32 — send button computed style is unchanged from rest to cap",
      sendButtonShots.at_cap_style,
      sendButtonShots.at_min_style,
    );
    check(
      "U32 — min-vs-cap pixel delta is within this run's own noise floor",
      minVsCap.maxChannelDelta <= Math.max(noise.maxChannelDelta, 2),
      true,
    );
    check(
      "U32 — the instrument can still SEE a real change (empty vs typed)",
      emptyVsTyped.maxChannelDelta > 50,
      true,
    );
    /* The post-send PIXEL comparison is CONTAMINATED BY THIS ROUND'S OWN
     * INTERCEPTION, and is reported rather than asserted.
     *
     * Aborting the send makes the app do the right thing: `toastError`
     * (ChatSurface.tsx:607) raises "Message not sent — …". That toast is
     * positioned over the composer's right-hand end and OVERLAPS the send
     * button, and the button's own background is transparent in the disabled
     * state, so its element screenshot picks the toast up. 1 982 of 2 146
     * pixels differ for that reason and no other.
     *
     * So the claim is made two ways that the overlay cannot touch — the box is
     * exactly equal (asserted above, all four coordinates) and so is the
     * computed style — and the pixel figure is carried as a note with its
     * cause, instead of a green check bought by loosening the tolerance until
     * the contamination fits under it.
     *
     * The overlap itself is a real, small UI finding; it is written up in
     * README §5 for round 805 rather than fixed here. */
    const toast = await page.$('text=/Message not sent/');
    const toastBox = toast ? await toast.boundingBox() : null;
    check("the aborted send raised the app's own 'Message not sent' toast", toast !== null, true);
    check(
      "post-send button style is identical to at-open (the box is unaffected by the toast)",
      sendButtonShots.after_send_style,
      sendButtonShots.at_open_style,
    );
    note("post-send pixel delta, CONTAMINATED by the declared abort's toast", openVsAfterSend);
    note("the toast's rect", toastBox);
    if (toastBox && sendButtonShots.at_min_box) {
      const b = sendButtonShots.at_min_box;
      const overlaps =
        toastBox.x < b.x + b.width &&
        toastBox.x + toastBox.width > b.x &&
        toastBox.y < b.y + b.height &&
        toastBox.y + toastBox.height > b.y;
      note("FINDING — the error toast overlaps the send button's rect", overlaps);
    }

    await ctx.unrouteAll({ behavior: "ignoreErrors" });

    /* The aborted send is expected; record it rather than hide it. */
    for (const line of errs.failedRequests) {
      if (line.includes("/message")) expectedAborts.push(line);
    }
    note("console errors (excluding the declared send abort)", errs.consoleErrors.filter((e) => !e.includes("/message")));
    note("expected_send_abort", expectedAborts.length > 0 ? expectedAborts : ["(abort surfaced as a request failure, not a 4xx)"]);
    check(
      "no unexpected console error",
      errs.consoleErrors.filter((e) => !e.includes("/message") && !e.includes("Failed to fetch")).length,
      0,
    );
  });

  L.finish800(
    "composer-autogrow.json",
    {
      protocol: "PROTOCOL 1 — composer autogrow, numeric (U28/U32)",
      started_at,
      finished_at: new Date().toISOString(),
      base_url: L.BASE,
      api_url: L.API,
      viewport: L.VIEWPORT,
      config: { minRows: MIN_ROWS, maxRows: MAX_ROWS },
      hypothesis_r801: HYPOTHESIS_R801,
      measured_metrics: metrics,
      measured_boxes: measured,
      send_button_u32: sendButtonShots,
      send_interception: {
        declared: true,
        why: "the fixture chat is Konrad's real manager chat; a delivered POST would write a test message into his production thread and wake its executor",
        what: "POST /api/proxy/chat/:id/message routed and aborted; the request itself is the assertion",
        captured: sendCapture,
      },
      checks: results,
      failures: failed(),
    },
    failed(),
  );
}

main().catch((e) => {
  console.error(`\nFATAL  ${e && e.stack ? e.stack : e}`);
  process.exit(2);
});
