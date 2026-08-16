/**
 * secret-sentinel.cjs — PROTOCOL 2, round 804.
 * docs/plan/14-ui-v3-quality.md § "Secret non-leakage" — the LEAKCANARY
 * protocol, end to end through the real UI.
 *
 * THE CLAIM UNDER TEST. A credential answered through SecretField reaches the
 * secret store and NOTHING ELSE. Not the DOM, not a response body, not the
 * secrets listing, not the chat thread, not the database. The only thing that
 * may enter the conversation is the NAME.
 *
 * ── THE STORE IS ISOLATED, AND THAT IS NOT OPTIONAL ───────────────────────
 *
 * This protocol WRITES secrets. `secret-store.ts:38` defaults `STORE_DIR` to
 * `/opt/ai-os/.secrets/store` — Konrad's real credentials — and `mark-pending`
 * against that store raises a real "for Konrad" flag on a real key in the real
 * UI. So the harness this talks to (:7814) was started with
 * `SECRET_STORE_DIR=/tmp/p800-store-804`, verified empty before the run
 * (`GET /api/secrets` → `{"secrets":[]}`), and the isolation is re-asserted
 * below as check #1 rather than assumed. A harness already listening on :7798
 * carried NO SECRET_STORE_DIR when this round started; borrowing it would have
 * written into the real store. See lib-804.cjs's header.
 *
 * ── HOW THE CANARY IS HANDLED ─────────────────────────────────────────────
 *
 * The token is generated HERE, by `crypto.randomBytes`, and it is never
 * printed to stdout and never written into the JSON — only its sha256, its
 * length and its prefix are. That is what makes the database leg meaningful:
 * if the full token appeared in any run's thread, it could only have got there
 * by leaking out of the field, because no other process on this machine has
 * ever seen it. A token echoed through this script's own console would end up
 * in THIS builder run's thread and destroy the very assertion it exists to
 * support.
 *
 * ── THE PREFIX QUERY IS VACUOUSLY RED, AND THE ARTIFACT SAYS SO ───────────
 *
 * The brief asks for `SELECT count(*) FROM runs WHERE thread::text LIKE
 * '%LEAKCANARY%'` and expects 0. Measured BEFORE this protocol ever ran: it
 * returns 12, and all twelve are operator-visibility planning/build/review
 * runs whose own BRIEFS contain the word "LEAKCANARY" — the protocol is named
 * in the planning corpus, so every agent briefed on it carries the string.
 * That query cannot return 0 in this database and never could. It is run
 * anyway, as the standing check the brief asks for, with its matching run ids
 * recorded so a reviewer can see what they are. The assertion that carries the
 * real claim is the FULL-TOKEN query underneath it.
 *
 * ── WHAT THIS PROTOCOL DELIBERATELY DOES NOT DO ───────────────────────────
 *
 * It does not send a chat message. The `[secret: name]` marker only reaches a
 * run's THREAD when the operator sends the composed draft, and the fixture
 * chat is Konrad's real manager chat — a send would append a test message to
 * his production thread and wake its executor. Nothing in this round's brief
 * authorises that.
 *
 * So the non-vacuity requirement is met one step earlier in the same code
 * path, at the point the app actually produces the marker: `onStored`
 * (ChatSurface.tsx:1836-1837) pushes the "secret stored: <name>" system line
 * and appends `[secret: <name>]` to the draft. Both are asserted in the DOM.
 * The thread is then read through the API and asserted to contain NEITHER the
 * canary NOR the marker — which is the correct expectation for a draft that
 * was never sent, and is stated as such rather than dressed up as a pass.
 * README §3.2 carries this in full.
 *
 * Run (README.md §2):
 *   FORGE_SESSION_COOKIE=… PHASE700_BASE_URL=http://127.0.0.1:7817 \
 *   PHASE700_API_URL=http://127.0.0.1:7814 node secret-sentinel.cjs [--write]
 */

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const L = require("./lib-804.cjs");

/** The secret this round asks for. Name is stable so a reviewer can find it in
 *  /tmp/p800-store-804; the VALUE is the random canary. */
const SECRET_NAME = "p800-804-sentinel-key";
const REQUEST_NOTE =
  "vps2 deploy needs the sentinel key to finish the rsync leg — paste the key issued for host ubuntu-16gb-nbg1-3-SK.";
/** The placeholder the secret is CREATED with. Deliberately not the canary:
 *  the canary must only ever exist inside the browser field. */
const PLACEHOLDER_VALUE = "placeholder-created-by-round-804-before-the-answer";

/** Where the token is parked for the psql leg. /tmp, 0600, removed at the end. */
const TOKEN_FILE = "/tmp/p800-804-canary.txt";

/**
 * Wrap `fetch` and `EventSource` before any app code runs, and keep every body
 * the page receives.
 *
 * `EventSource` matters as much as `fetch` here: `useRunEvents.ts:75` streams
 * the chat thread over SSE as named `snapshot`/`append` frames, which is
 * exactly the channel a leaked value would arrive back on. Named events do not
 * fire a `message` listener, so the instance's `addEventListener` is wrapped to
 * record EVERY typed frame rather than just the default one.
 */
const CAPTURE_INIT = `(() => {
  window.__p800 = { bodies: [], sse: [], errors: [] };
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const res = await origFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : (args[0] && args[0].url) || "(unknown)";
      res.clone().text().then(
        (body) => window.__p800.bodies.push({ url, status: res.status, body }),
        (e) => window.__p800.errors.push("clone/text failed: " + String(e)),
      );
    } catch (e) {
      window.__p800.errors.push("fetch wrapper: " + String(e));
    }
    return res;
  };
  const OES = window.EventSource;
  function Wrapped(url, init) {
    const es = new OES(url, init);
    const origAdd = es.addEventListener.bind(es);
    es.addEventListener = function (type, fn, opts) {
      return origAdd(type, function (ev) {
        try {
          if (ev && typeof ev.data !== "undefined") {
            window.__p800.sse.push({ url: String(url), type: String(type), data: String(ev.data) });
          }
        } catch (e) { window.__p800.errors.push("sse wrapper: " + String(e)); }
        return fn.apply(this, arguments);
      }, opts);
    };
    return es;
  }
  Wrapped.prototype = OES.prototype;
  for (const k of ["CONNECTING", "OPEN", "CLOSED"]) Wrapped[k] = OES[k];
  window.EventSource = Wrapped;
})();`;

/** POST helper against the worktree harness. */
async function apiPost(pathname, body) {
  const r = await fetch(`${L.API}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* a non-JSON body is itself the diagnostic */
  }
  if (!r.ok) throw new Error(`POST ${pathname} → ${r.status}: ${text.slice(0, 300)}`);
  return parsed;
}

/**
 * One read-only SELECT against the live content_forge.
 *
 * THE SQL GOES OVER STDIN, NOT `-c`, AND THAT IS A CANARY-HANDLING DECISION.
 * The first version passed the token as `-v tok=…` and interpolated `:'tok'`.
 * Two things were wrong with it. psql does not interpolate variables into a
 * `-c` string, so it failed outright — and the resulting `execFileSync` error
 * printed the whole argv, TOKEN INCLUDED, into this builder's own transcript.
 * A canary that lands in a run's thread by way of an error message makes the
 * very query it was generated for meaningless.
 *
 * So: the token is dollar-quoted into the statement (it is `LEAKCANARY-` plus
 * hex — no quoting hazard exists) and the statement is written to psql's
 * STDIN, which never appears in `ps`, in argv, or in an exec error.
 *
 * THE CONNECTION STRING USED TO BE IN ARGV, AND THAT WAS THE SAME BUG WITH A
 * WORSE PAYLOAD (round 807 finding 3). Every version through round 806 passed
 * `process.env.DATABASE_URL` — `postgres://postgres:<PASSWORD>@…` — as argv[0]
 * to `execFileSync`. Node builds a failed-exec `Error` whose `.message` is
 * `Command failed: psql <every argument, verbatim>`, so ANY psql failure
 * (server down, role missing, a typo in the SQL, ON_ERROR_STOP firing) printed
 * the postgres superuser password into this script's stderr, into the agent
 * transcript that ran it, and from there into `runs.thread` — permanently, in
 * a database the agent fleet reads. The scrub below covered only the canary,
 * so it did nothing about it. This is the ironic failure mode for a
 * credential-leak sentinel and it had already fired on real runs.
 *
 * The fix is both halves, because either alone is insufficient:
 *   1. The password never enters argv. The URL is parsed here and psql gets
 *      `-h/-p/-U/-d`; the password travels in `PGPASSWORD` on the CHILD's
 *      environment, which appears in no exec error and no `ps` output (Linux
 *      exposes /proc/<pid>/environ only to the same uid, unlike the
 *      world-readable /proc/<pid>/cmdline that argv lands in). DATABASE_URL is
 *      deleted from the child env too, so a future subprocess of psql cannot
 *      re-widen the hole.
 *   2. `scrub()` redacts the password UNCONDITIONALLY — not only when a canary
 *      was passed. Defence in depth: if some other path ever gets the password
 *      into a psql diagnostic (a libpq notice, a server-side message echoing
 *      the conninfo), it still cannot reach the transcript.
 *
 * A fresh token is generated on every run, so a token exposed by an earlier
 * failure can never weaken a later run's assertion. The PASSWORD gets no such
 * mercy — it is long-lived, so the only safe number of exposures is zero.
 */
function psql(sql, redact = null) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is unset — run `set -a; . /opt/ai-os/.secrets/forge-control.env; set +a` first (README §2 step A)",
    );
  }
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error(`psql(): SELECT only, refused: ${sql.slice(0, 60)}`);

  /* Parse before anything can throw with the URL in the message: Node's URL
   * TypeError says only "Invalid URL", but it carries the input on `.input`,
   * and a careless `${err}` elsewhere would print it. So the failure path here
   * interpolates NOTHING. */
  let dsn;
  try {
    dsn = new URL(url);
  } catch {
    throw new Error("DATABASE_URL is not a parseable URL (value withheld — it contains the password)");
  }
  const password = decodeURIComponent(dsn.password || "");
  const user = decodeURIComponent(dsn.username || "") || "postgres";
  const database = decodeURIComponent(dsn.pathname.replace(/^\//, "")) || "content_forge";
  const host = dsn.hostname || "127.0.0.1";
  const port = dsn.port || "5432";

  /* Unconditional password redaction, then the canary if one was passed. */
  const scrub = (s) => {
    let out = String(s);
    if (password) out = out.split(password).join("<pgpassword-redacted>");
    if (redact) out = out.split(redact).join("<canary-redacted>");
    return out;
  };

  const childEnv = { ...process.env };
  delete childEnv.DATABASE_URL;
  if (password) childEnv.PGPASSWORD = password;

  try {
    return execFileSync(
      "psql",
      ["-h", host, "-p", port, "-U", user, "-d", database, "-t", "-A", "-F", "|", "-v", "ON_ERROR_STOP=1"],
      { input: sql, encoding: "utf8", env: childEnv },
    ).trim();
  } catch (err) {
    throw new Error(
      `psql failed: ${scrub(err.message)}\nstderr: ${scrub(err.stderr ?? "")}`,
    );
  }
}

async function main() {
  const { check, note, results, failed } = L.makeChecker();
  const started_at = new Date().toISOString();

  /* The canary. Generated here, never logged, never put in the JSON. */
  const canary = `LEAKCANARY-${crypto.randomBytes(16).toString("hex")}`;
  const canarySha = crypto.createHash("sha256").update(canary).digest("hex");
  fs.writeFileSync(TOKEN_FILE, canary, { mode: 0o600 });

  const transcript = [];
  const say = (line) => {
    transcript.push(line);
    console.log(`      · ${line}`);
  };

  let domHits = null;
  let bodyHits = null;
  let sseHits = null;
  let listingHits = null;
  let threadHits = null;
  let dbFullToken = null;
  let dbPrefix = null;
  let dbPrefixRows = null;
  let capturedCounts = null;
  let markerInDraft = null;
  let systemLine = null;

  /* ── 0. the store is isolated ────────────────────────────────────────── */
  const before = await L.api("/api/secrets");
  const preexisting = (before.secrets ?? []).map((s) => s.name);
  check(
    "the harness's store is ISOLATED (no real credential names present)",
    preexisting.filter((n) => !n.startsWith("p800-804")).length,
    0,
  );
  note("secret names visible through the harness before the run", preexisting);
  say(`store check — harness :7814 lists ${preexisting.length} secret(s): ${JSON.stringify(preexisting)}`);

  /* ── 1. an agent creates the secret and raises the request ───────────── */
  const chat = await L.resolveChat();
  const created = await apiPost("/api/secrets", {
    name: SECRET_NAME,
    value: PLACEHOLDER_VALUE,
    note: REQUEST_NOTE,
  });
  say(`created secret "${created.secret.name}" with the agent's request note (placeholder value, NOT the canary)`);
  await apiPost(`/api/secrets/${SECRET_NAME}/mark-pending`, {
    requested_by_run_id: chat.id,
  });
  say(`marked pending, requested_by_run_id=${chat.id}`);

  const afterMark = await L.api("/api/secrets");
  const row = (afterMark.secrets ?? []).find((s) => s.name === SECRET_NAME);
  check("the secret exists and is pending", { pending: row?.pending, name: row?.name }, { pending: true, name: SECRET_NAME });
  check("the request note is on the wire", row?.note, REQUEST_NOTE);
  check("the requesting run id is on the wire", row?.requestedByRunId, chat.id);
  check("NO value is on the listing wire", Object.keys(row ?? {}).includes("value"), false);

  /* ── 2. the UI badges it, auto-opens, and takes the answer ───────────── */
  await L.withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    await page.addInitScript(CAPTURE_INIT);
    const errs = L.watchErrors(page);
    await L.openChat(page);

    const secretBtn = await L.resolveOne(page, "secret-button");
    check("hook secret-button resolved to exactly 1 node", secretBtn.tried.at(-1).matched, 1);
    const btnText = await secretBtn.handle.evaluate((el) => el.textContent);
    const btnTitle = await secretBtn.handle.evaluate((el) => el.getAttribute("title"));
    check("the secret button carries the pending badge count", btnText, "secret1");
    check("the button's title names the secret and nothing else", btnTitle, `waiting for ${SECRET_NAME} — click to answer`);
    say(`UI badged the secret button: text=${JSON.stringify(btnText)} title=${JSON.stringify(btnTitle)}`);

    /* The panel must have opened BY ITSELF — no click. */
    const valueField = await L.resolveOne(page, "secret-panel-value");
    const nameField = await L.resolveOne(page, "secret-panel-name");
    const submit = await L.resolveOne(page, "secret-submit");
    check("the panel AUTO-OPENED (no click was issued)", valueField.tried.at(-1).matched, 1);
    check("the panel is in ANSWER mode", await submit.handle.evaluate((el) => el.textContent), "answer request");
    check("the name is prefilled and read-only", await nameField.handle.evaluate((el) => ({ v: el.value, ro: el.readOnly })), { v: SECRET_NAME, ro: true });
    const notePresent = await page.evaluate((n) => document.body.innerText.includes(n), REQUEST_NOTE);
    check("the agent's request note is rendered", notePresent, true);
    say("panel auto-opened in answer mode, name read-only, request note rendered");

    /* ── the canary goes in, through a real keystroke path ───────────── */
    await valueField.handle.click();
    await page.keyboard.insertText(canary);
    await submit.handle.click();
    await page.waitForTimeout(2_500);
    say("answered the request with the canary and clicked “answer request”");

    /* ── the app's own reaction: NAME only ───────────────────────────── */
    const composer = await L.resolveOne(page, "composer-input");
    markerInDraft = await composer.handle.evaluate((el) => el.value);
    systemLine = await page.evaluate(() => document.body.innerText.includes("secret stored:"));
    check("the NAME marker reached the composer draft", markerInDraft.includes(`[secret: ${SECRET_NAME}]`), true);
    check("the draft does NOT contain the canary", markerInDraft.includes("LEAKCANARY"), false);
    check("the app pushed its 'secret stored:' system line", systemLine, true);
    say(`composer draft after answering: ${JSON.stringify(markerInDraft)}`);

    /* ── ZERO HITS, five ways ────────────────────────────────────────── */
    const dom = await page.content();
    domHits = (dom.match(new RegExp(canary, "g")) ?? []).length;

    const captured = await page.evaluate(() => ({
      bodies: window.__p800.bodies.map((b) => ({ url: b.url, status: b.status, body: b.body })),
      sse: window.__p800.sse.map((s) => ({ url: s.url, type: s.type, data: s.data })),
      errors: window.__p800.errors,
    }));
    bodyHits = captured.bodies.filter((b) => b.body.includes(canary)).map((b) => b.url);
    sseHits = captured.sse.filter((s) => s.data.includes(canary)).map((s) => `${s.url}#${s.type}`);
    capturedCounts = {
      response_bodies_captured: captured.bodies.length,
      sse_frames_captured: captured.sse.length,
      wrapper_errors: captured.errors,
      /* Proof the wrapper was actually working: the listing endpoint must be
       * among the captured bodies. A wrapper that captured nothing would score
       * a perfect zero-hits pass. */
      saw_the_secrets_listing: captured.bodies.some((b) => b.url.includes("/secrets")),
    };
    check("the fetch wrapper actually captured traffic", captured.bodies.length > 0, true);
    check("the fetch wrapper saw the /secrets listing (not a blind pass)", capturedCounts.saw_the_secrets_listing, true);
    check("ZERO canary hits in the rendered DOM", domHits, 0);
    check("ZERO canary hits in any response body the page received", bodyHits, []);
    check("ZERO canary hits in any SSE frame the page received", sseHits, []);
    say(`swept ${captured.bodies.length} response bodies and ${captured.sse.length} SSE frames`);

    note("console errors", errs.consoleErrors);
    check("no console error", errs.consoleErrors.length, 0);
  });

  /* ── 3. the listing, the thread, and the database ───────────────────── */
  const listing = await L.api("/api/secrets");
  listingHits = JSON.stringify(listing).includes(canary) ? "PRESENT" : 0;
  check("ZERO canary hits in GET /api/secrets", listingHits, 0);
  const stored = (listing.secrets ?? []).find((s) => s.name === SECRET_NAME);
  check("answering CLEARED the pending flag", stored?.pending, false);
  check("the stored value is real (byte length matches the canary)", stored?.bytes, canary.length);
  say(`store now holds ${stored?.bytes} bytes under "${SECRET_NAME}" — the right size, and unreadable from the listing`);

  const thread = await L.api(`/api/chat/${chat.id}`);
  const threadText = JSON.stringify(thread);
  threadHits = threadText.includes(canary) ? "PRESENT" : 0;
  check("ZERO canary hits in the chat run's thread (via the API)", threadHits, 0);
  /* Stated, not asserted-as-a-win: the marker is NOT in the thread either,
   * because this protocol deliberately never sent the composed draft. */
  note(
    "the '[secret: name]' marker in the THREAD (expected absent — the draft was never sent; see the header)",
    threadText.includes(`[secret: ${SECRET_NAME}]`),
  );

  dbFullToken = psql(
    `SELECT count(*) FROM runs WHERE thread::text LIKE '%' || $tok$${canary}$tok$ || '%'`,
    canary,
  );
  check("ZERO canary hits in the DATABASE (full token, the assertion that counts)", dbFullToken, "0");

  dbPrefix = psql("SELECT count(*) FROM runs WHERE thread::text LIKE '%LEAKCANARY%'");
  dbPrefixRows = psql(
    "SELECT id || ' ' || left(coalesce(title,'(untitled)'),52) FROM runs WHERE thread::text LIKE '%LEAKCANARY%' ORDER BY started_at",
  ).split("\n").filter(Boolean);
  note("the brief's prefix query (VACUOUSLY RED — see the header)", dbPrefix);
  note("what those rows are — every one is a run briefed on this protocol by name", dbPrefixRows);
  say(`DB: full-token matches = ${dbFullToken}; bare-word 'LEAKCANARY' matches = ${dbPrefix} (all briefs, listed in the JSON)`);

  fs.rmSync(TOKEN_FILE, { force: true });
  say("canary file removed from /tmp");

  const payload = {
    protocol: "PROTOCOL 2 — secret non-leakage sentinel (LEAKCANARY)",
    started_at,
    finished_at: new Date().toISOString(),
    base_url: L.BASE,
    api_url: L.API,
    secret_store_dir: "/tmp/p800-store-804 (isolated — NOT /opt/ai-os/.secrets/store)",
    canary: {
      never_printed: true,
      sha256: canarySha,
      length: canary.length,
      prefix: "LEAKCANARY-",
      note: "the token itself is not recorded anywhere; only this digest. See the file header for why.",
    },
    secret: { name: SECRET_NAME, request_note: REQUEST_NOTE, requested_by_run_id: chat.id },
    sweep: {
      dom_hits: domHits,
      response_body_hits: bodyHits,
      sse_frame_hits: sseHits,
      listing_hits: listingHits,
      thread_hits: threadHits,
      db_full_token_hits: dbFullToken,
      db_bare_word_hits: dbPrefix,
      db_bare_word_rows: dbPrefixRows,
      capture_coverage: capturedCounts,
    },
    marker: { composer_draft: markerInDraft, system_line_rendered: systemLine, sent: false },
    checks: results,
    failures: failed(),
  };

  fs.writeFileSync(
    path.join(L.OUT_DIR, "secret-sentinel.md"),
    `# Round 804 — secret non-leakage sentinel (transcript)\n\n` +
      `Generated by \`secret-sentinel.cjs\`. The canary token is deliberately absent\n` +
      `from this file; only its sha256 is recorded (\`${canarySha}\`).\n\n` +
      transcript.map((l) => `- ${l}`).join("\n") +
      `\n\n**Verdict:** ${failed() === 0 ? "PASS" : `${failed()} FAILURE(S)`} — ` +
      `${results.filter((r) => "ok" in r).length} checks.\n`,
  );

  L.finish800("secret-sentinel.json", payload, failed());
}

main().catch((e) => {
  console.error(`\nFATAL  ${e && e.stack ? e.stack : e}`);
  process.exit(2);
});
