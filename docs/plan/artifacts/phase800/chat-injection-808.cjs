/**
 * chat-injection-808.cjs — round 808's BROWSER battery: the colour-coded,
 * rich-rendered transcript, and fourteen hostile payloads inside it.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT ONLY A BROWSER CAN PROVE
 * ═══════════════════════════════════════════════════════════════════════════
 * `scripts/checks/check-chat-rich.tsx` renders the same payloads server-side
 * and asserts over the HTML (222 assertions, all passing). It cannot prove the
 * one claim that matters most: THAT NOTHING WAS FETCHED. A `<link
 * rel="preload" as="image">` that React emits, a CSS `@import`, an `<img>` a
 * future plugin lets through — those are requests, and only a real page makes
 * them. So this file watches every request the page issues, for the whole
 * session, and matches it against the beacon.
 *
 * Round 804's `note-injection.cjs` did exactly this for the SECRETS PANEL and
 * is re-run unchanged beside this file. This is its sibling for the TRANSCRIPT,
 * which is the surface round 808 made rich.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IT ASSERTS
 * ═══════════════════════════════════════════════════════════════════════════
 *  §1  COLOUR: each of the nine role identities renders its own tint, the
 *      computed colours match `theme.css` in BOTH themes, and every role's
 *      card is visually distinct from every other's.
 *  §2  DIRECTION: inbound and outbound cards carry their marker; the card with
 *      neither a `peer_role` stamp nor a team-cache entry says "unknown role"
 *      instead of borrowing one.
 *  §3  INERT: the transcript contains no script/img/iframe/svg/form/style/link
 *      node, no inline handler, no `javascript:`/`data:` href — and ZERO
 *      requests left for the beacon host.
 *  §4  CONTROLS: the `forge:ui` choice renders enabled buttons in the manager
 *      chat; clicking one writes into the COMPOSER and sends nothing; the
 *      secret control opens the secure panel and puts no value in the thread.
 *  §5  TOOL BLOCKS STILL COLLAPSE — the pre-808 behaviour this round must not
 *      break.
 *
 * Run (README.md §2 for the servers; this round's own recipe is in §7):
 *   node docs/plan/artifacts/phase800/fixture-api-808.cjs --port 7834 &
 *   … build /tmp/p800-808-web against it, serve on :7837, mint a cookie …
 *   FORGE_SESSION_COOKIE=… PHASE700_BASE_URL=http://127.0.0.1:7837 \
 *     node docs/plan/artifacts/phase800/chat-injection-808.cjs [--write]
 */

const L = require("./lib-804.cjs");
const { CHAT_ID, PEER, PAYLOADS, BEACON } = require("./fixture-api-808.cjs");

const ROLES = [
  "architect",
  "planner",
  "builder",
  "reviewer",
  "researcher",
  "scout",
  "steward",
  "tester",
];

/** Anything that would mean a payload's URL was actually requested. */
const beaconish = (url) =>
  url.includes("127.0.0.1:9") || url.includes("p800-808-beacon") || url.includes("track.png");

/** Open the FIXTURE chat. `lib-804.openChat` clicks a chat by title text,
 *  which is exactly what is wanted here — the fixture list has one row. */
async function openFixtureChat(page) {
  await L.openChat(page, "phase800 round808 fixture chat");
}

/** Everything §1–§3 reads, in one page evaluation. */
async function readTranscript(page) {
  return page.evaluate(() => {
    const viewport = document.querySelector("[data-comms-direction]")?.closest("div[class]")
      ?.parentElement;
    const cards = [...document.querySelectorAll("[data-comms-direction]")].map((el) => {
      const inner = el.firstElementChild;
      const cs = inner ? getComputedStyle(inner) : null;
      return {
        direction: el.getAttribute("data-comms-direction"),
        role: el.getAttribute("data-comms-role"),
        peer: el.getAttribute("data-comms-peer"),
        background: cs ? cs.backgroundColor : "",
        borderLeftColor: cs ? cs.borderLeftColor : "",
        borderLeftWidth: cs ? cs.borderLeftWidth : "",
        header: (el.textContent ?? "").slice(0, 120),
      };
    });
    /* The whole message list, not just the cards: a payload that escaped into
     * the operator's own prose would be outside a comms card. */
    const root = document.querySelector("[data-comms-direction]")?.closest("div")?.parentElement
      ?? document.body;
    const scope = root.parentElement ?? root;
    return {
      cards,
      text: scope.textContent ?? "",
      live: {
        script: scope.querySelectorAll("script").length,
        img: scope.querySelectorAll("img").length,
        iframe: scope.querySelectorAll("iframe").length,
        svg: scope.querySelectorAll("svg").length,
        form: scope.querySelectorAll("form").length,
        style: scope.querySelectorAll("style").length,
        link: scope.querySelectorAll("link").length,
        object: scope.querySelectorAll("object,embed").length,
        handler: scope.querySelectorAll("[onerror],[onload],[onclick]").length,
        jsHref: scope.querySelectorAll('a[href^="javascript:"]').length,
        dataHref: scope.querySelectorAll('a[href^="data:"]').length,
        srcAttr: scope.querySelectorAll("[src]").length,
      },
      /* Round 808's own affordances. */
      choiceButtons: [...document.querySelectorAll('[data-forge-ui="choice"] button')].map((b) => ({
        label: (b.textContent ?? "").trim().slice(0, 40),
        disabled: b.disabled,
      })),
      secretBlocks: document.querySelectorAll('[data-forge-ui="secret"]').length,
      invalidBlocks: document.querySelectorAll('[data-forge-ui="invalid"]').length,
      toolRows: document.querySelectorAll("[data-tool-row]").length,
      viewportPresent: viewport !== null,
    };
  });
}

/** The palette as the BROWSER resolves it, for the theme currently applied. */
async function readPalette(page, roles) {
  return page.evaluate((list) => {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const role of list) {
      const key = role[0].toUpperCase() + role.slice(1);
      out[role] = {
        bg: cs.getPropertyValue(`--fg-roleBg${key}`).trim(),
        ink: cs.getPropertyValue(`--fg-roleInk${key}`).trim(),
      };
    }
    return out;
  }, roles);
}

async function main() {
  const { check, note, results, failed } = L.makeChecker();
  const started_at = new Date().toISOString();
  const evidence = { started_at, chat_id: CHAT_ID, beacon: BEACON, themes: {} };

  await L.withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    const errs = L.watchErrors(page);

    /** EVERY request the page makes, for the entire session. */
    const requests = [];
    page.on("request", (r) => requests.push(r.url()));

    await openFixtureChat(page);

    for (const theme of ["dark", "light"]) {
      await L.setTheme(page, theme);
      const palette = await readPalette(page, [...ROLES, "unknown"]);
      const t = await readTranscript(page);
      const bg = await L.sampleBackground(page);
      note(`${theme}: sampled body background`, bg);

      /* ── §1 colour ─────────────────────────────────────────────────── */
      /* Eight roles + the unstamped peer = 9 inbound, 1 outbound echo, and one
       * card per payload (all sent by the builder). Written as arithmetic
       * rather than as a number so the fixture and the assertion cannot drift
       * apart the way they did on the first run. */
      check(
        `${theme} — one card per role, plus the unstamped one, the echo and the payloads`,
        t.cards.length,
        ROLES.length + 1 + 1 + PAYLOADS.length,
      );

      const byRole = new Map();
      for (const card of t.cards) if (card.role) byRole.set(card.role, card);

      for (const role of ROLES) {
        const card = byRole.get(role);
        check(`${theme} — ${role} has a card`, card !== undefined, true);
        if (!card) continue;
        check(
          `${theme} — ${role} paints --fg-roleBg${role} (${palette[role].bg})`,
          card.background,
          hexToRgb(palette[role].bg),
        );
        check(
          `${theme} — ${role}'s left rule is its ink`,
          card.borderLeftColor,
          hexToRgb(palette[role].ink),
        );
        check(`${theme} — ${role}'s rule is 3px`, card.borderLeftWidth, "3px");
      }

      const tints = new Set(
        ROLES.map((role) => byRole.get(role)?.background).filter((v) => v !== undefined),
      );
      check(
        `${theme} — every role's tint is DISTINCT (that is the whole feature)`,
        tints.size,
        ROLES.length,
      );

      /* ── §2 direction and the honest unknown ───────────────────────── */
      const outbound = t.cards.filter((c) => c.direction === "out");
      check(`${theme} — exactly one outbound echo`, outbound.length, 1);
      check(`${theme} — the echo says "to"`, outbound[0]?.header.includes("to"), true);
      check(
        `${theme} — the echo carries the arrow`,
        outbound[0]?.header.includes("▸"),
        true,
      );
      const unstamped = t.cards.find((c) => c.peer === PEER.unstamped);
      check(`${theme} — the unstamped peer has a card`, unstamped !== undefined, true);
      check(
        `${theme} — ...and it says "unknown role" rather than guessing`,
        unstamped?.header.includes("unknown role"),
        true,
      );
      check(
        `${theme} — ...and takes the neutral tint`,
        unstamped?.background,
        hexToRgb(palette.unknown.bg),
      );

      /* ── §3 inert ──────────────────────────────────────────────────── */
      check(`${theme} — no live node anywhere in the transcript`, t.live, {
        script: 0,
        img: 0,
        iframe: 0,
        svg: 0,
        form: 0,
        style: 0,
        link: 0,
        object: 0,
        handler: 0,
        jsHref: 0,
        dataHref: 0,
        srcAttr: 0,
      });
      for (const [id] of PAYLOADS) {
        check(`${theme} — payload ${id} is on screen (nothing swallowed)`, t.text.includes(`payload ${id}`), true);
      }
      check(
        `${theme} — the escaped script tag is TEXT`,
        t.text.includes("<script>fetch("),
        true,
      );
      check(
        `${theme} — the escaped img tag is TEXT`,
        t.text.includes("<img src=x onerror="),
        true,
      );
      check(
        `${theme} — the image URL is shown as a marker, not loaded`,
        t.text.includes("image not loaded"),
        true,
      );

      /* ── §4 controls ───────────────────────────────────────────────── */
      check(`${theme} — the choice block renders two options`, t.choiceButtons.length, 2);
      check(
        `${theme} — and they are ENABLED here (the manager chat has a composer)`,
        t.choiceButtons.every((b) => b.disabled === false),
        true,
      );
      check(`${theme} — the secret block renders`, t.secretBlocks, 1);
      check(`${theme} — nothing was mis-parsed into an invalid block`, t.invalidBlocks, 0);

      evidence.themes[theme] = { palette, cards: t.cards, live: t.live, background: bg };

      /* TWO screenshots per theme, because they answer different questions.
       * The transcript opens scrolled to its end — which is where the hostile
       * payloads are, and that is the shot that shows them rendering as text.
       * The colour-coding is eleven cards further up, so it gets its own shot
       * with the architect card scrolled to the top; a reviewer asked to check
       * "can Konrad tell a builder from a reviewer" should not have to scroll
       * a PNG. */
      const tail = `phase800-808-transcript-${theme}.png`;
      await page.screenshot({ path: `${L.OUT_DIR}/${tail}`, fullPage: false });
      note(`${theme}: screenshot (payload end of the thread)`, tail);

      await page.evaluate(() => {
        document
          .querySelector('[data-comms-role="architect"]')
          ?.scrollIntoView({ block: "start", behavior: "instant" });
      });
      await page.waitForTimeout(500);
      const roles = `phase800-808-roles-${theme}.png`;
      await page.screenshot({ path: `${L.OUT_DIR}/${roles}`, fullPage: false });
      note(`${theme}: screenshot (every role tint on one screen)`, roles);
    }

    /* ── §3b THE NETWORK, for the whole session ─────────────────────────── */
    const beaconHits = requests.filter(beaconish);
    check("ZERO requests to any injected host", beaconHits, []);
    note("requests issued in total", requests.length);

    /* ── §4b clicking a control writes to the composer and sends nothing ── */
    await L.setTheme(page, "dark");
    const before = await page.evaluate(
      () => document.querySelectorAll("[data-comms-direction]").length,
    );
    const posts = [];
    page.on("request", (r) => {
      if (r.method() !== "GET") posts.push(`${r.method()} ${r.url()}`);
    });
    await page.click('[data-forge-ui="choice"] button');
    await page.waitForTimeout(600);
    const composer = await L.resolveOne(page, "composer-input");
    const draft = await composer.handle.evaluate((el) => el.value);
    check("clicking an option writes its value into the composer", draft.includes("vps1"), true);
    check("...and sends NOTHING", posts, []);
    check(
      "...and adds no message to the transcript",
      await page.evaluate(() => document.querySelectorAll("[data-comms-direction]").length),
      before,
    );
    const picked = await page.evaluate(
      () => document.querySelector('[data-forge-ui="choice"] button')?.textContent ?? "",
    );
    check("...and the option shows it was picked", picked.includes("✓"), true);

    /* ── §4c the secret control opens the secure panel ──────────────────── */
    await page.click('[data-forge-ui="secret"] button');
    await page.waitForTimeout(600);
    const panel = await L.resolveOne(page, "secret-panel-value");
    check("the secret control opens the secure panel", panel.handle !== null, true);
    const panelValue = await panel.handle.evaluate((el) => el.value);
    check("...with an empty value field — no credential is ever pre-filled", panelValue, "");
    check(
      "...and no credential text entered the thread",
      await page.evaluate(() => (document.body.textContent ?? "").includes("vps2_deploy_key_VALUE")),
      false,
    );

    /* ── §5 the pre-808 behaviour: tool blocks still collapse ───────────── */
    const toolRow = await page.$("[data-tool-row]");
    check("the streamed Bash call still renders a tool row", toolRow !== null, true);
    const paneText = () =>
      page.evaluate(() => document.querySelector("[data-tool-row]")?.textContent ?? "");
    /* The toggle is the row's HEADER, not the row: once expanded, the row's
     * centre is inside the ARGS pane and a click there does nothing. Clicking
     * the row and calling that "it did not collapse" would have been an
     * instrument bug reported as an app regression — it was, on the first
     * run. */
    const header = "[data-tool-row] > div:first-child";
    check("collapsed: no ARGS pane", (await paneText()).includes("ARGS"), false);
    await page.click(header);
    await page.waitForTimeout(300);
    const expanded = await paneText();
    check("expanded: the ARGS pane appears", expanded.includes("ARGS"), true);
    check("expanded: the RESULT pane appears", expanded.includes("RESULT"), true);
    check(
      "expanded: the payload is verbatim, not summarised",
      expanded.includes("npx tsc --noEmit"),
      true,
    );
    await page.click(header);
    await page.waitForTimeout(300);
    check("collapsing again hides it", (await paneText()).includes("ARGS"), false);

    /* ── §6 the page itself ─────────────────────────────────────────────── */
    check(
      "console errors",
      errs.consoleErrors.filter((e) => !e.includes("favicon")),
      [],
    );
    check("failed requests", errs.failedRequests, []);

    evidence.requests = { total: requests.length, beaconHits };
    await page.close();
  });

  evidence.results = results;
  L.finish800("chat-injection-808.json", evidence, failed());
}

/** theme.css declares hex; getComputedStyle returns rgb(). Compare parsed
 *  values, not strings — round 806's contrast gate learned this the hard way
 *  (a browser re-serialises `#ffffff` as `rgb(255, 255, 255)`). */
function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, "");
  if (h.length === 3) h = [...h].map((c) => c + c).join("");
  const n = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
  return `rgb(${n[0]}, ${n[1]}, ${n[2]})`;
}

main().catch((err) => {
  console.error(err.stack ?? String(err));
  process.exit(1);
});
