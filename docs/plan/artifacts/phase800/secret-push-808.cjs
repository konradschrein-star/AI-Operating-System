/**
 * secret-push-808.cjs — ROUND 808, PROTOCOL: does the panel open by ITSELF,
 * and how long does Konrad wait?
 *
 * Konrad's requirement, verbatim: "when I ask for a secret this thing should
 * automatically sort of open up and there should be text appearing in there".
 * Phase 800 satisfied the "open up" half on a 60 s `refetchInterval`, so the
 * honest statement of what shipped was "it opens up, in nought to sixty
 * seconds, uniformly distributed". This protocol measures the number, on both
 * trees, so the improvement is a measurement and not a claim.
 *
 * TWO STAGES, deliberately, because they can fail independently:
 *
 *   STAGE A — the wire. Subscribe to `GET /api/secrets/events`, then drive
 *     every mutation path and record the delay between the mutation's HTTP
 *     response and the frame landing. Also asserts the two SILENCES that keep
 *     the panel from becoming hostile: storing a secret with no `for_konrad`
 *     flag pushes NOTHING, and no frame anywhere carries a secret value.
 *     Skipped with a recorded reason when the tree under test has no such
 *     route (that is the BEFORE tree, and "404" is itself the before-number).
 *
 *   STAGE B — the browser. Open the chat, let it settle, then have an "agent"
 *     raise a request from OUTSIDE the browser and measure wall-clock until
 *     the composer's secret panel is open with that agent's note rendered in
 *     it. This is the number Konrad actually experiences. Repeated `--samples`
 *     times because on the polled tree it is a random variable, not a
 *     constant: one lucky sample near a tick boundary would flatter it.
 *
 * WHAT THIS PROTOCOL WRITES. It creates and deletes secrets. `secret-store.ts`
 * defaults `STORE_DIR` to /opt/ai-os/.secrets/store — Konrad's REAL
 * credentials — so the harness it points at MUST have been started with
 * `SECRET_STORE_DIR` somewhere under /tmp. That is asserted here, not assumed:
 * the run aborts unless `GET /api/secrets` comes back with a store that
 * contains none of the names the real one does. Values written are the string
 * "NOT-A-REAL-VALUE-808"; nothing here reads a value back except the one
 * assertion that the stream never carries one.
 *
 * Run (see README §2 for the servers; NOTE this round needs the SSE-capable
 * harness `scripts/checks/serve-sse-808.ts`, not `serve-v3-7798.ts`, which
 * buffers every response and cannot serve a stream at all):
 *
 *   PHASE700_BASE_URL=http://127.0.0.1:7849 PHASE700_API_URL=http://127.0.0.1:7848 \
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-808.txt)" \
 *     node docs/plan/artifacts/phase800/secret-push-808.cjs --label after [--samples 3] [--write]
 *
 * Non-destructive by default (round 705's rule): without `--write` the JSON
 * lands in /tmp/phase800-out and the committed artifact is left alone.
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

/** Label for the tree under test — goes in the filename and the JSON, so the
 *  before/after pair cannot be mixed up by a reader or by a rerun. */
const LABEL = (() => {
  const i = process.argv.indexOf("--label");
  const v = i > 0 ? process.argv[i + 1] : undefined;
  if (!v || v.startsWith("--")) {
    throw new Error("--label <before|after|…> is required so the two runs cannot be confused");
  }
  return v;
})();

const SAMPLES = (() => {
  const i = process.argv.indexOf("--samples");
  if (i < 0) return 3;
  const n = Number(process.argv[i + 1]);
  if (!Number.isInteger(n) || n < 1 || n > 10) {
    throw new Error(`--samples must be an integer in [1,10]; got ${process.argv[i + 1]}`);
  }
  return n;
})();

/** Fixture names. Distinct per sample so a stale `.pending` marker from an
 *  earlier sample can never be mistaken for the one under test. */
const NAME = (n) => `p808-push-fixture-${n}`;
const NOTE = (n) =>
  `round 808 fixture ${n}: paste the VPS2 root key here so I can finish the migration`;
const PLACEHOLDER = "NOT-A-REAL-VALUE-808";

async function apiJson(method, pathname, body) {
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed, raw: text };
}

/** Abort unless the harness is pointed at a throwaway store. The real store
 *  holds Konrad's live credentials and this protocol writes and deletes. */
async function assertIsolatedStore(note) {
  const { status, body } = await apiJson("GET", "/api/secrets");
  if (status !== 200) throw new Error(`GET /api/secrets on ${API} returned ${status}`);
  const names = (body?.secrets ?? []).map((s) => s.name);
  const REAL = ["twenty-crm-admin", "github-pat-konrad"];
  const hit = names.filter((n) => REAL.includes(n));
  if (hit.length) {
    throw new Error(
      `REFUSING TO RUN: ${API} is serving a store that contains ${JSON.stringify(hit)} — ` +
        "that looks like Konrad's real credential store. Start the harness with " +
        "SECRET_STORE_DIR=/tmp/… (README §2 step A).",
    );
  }
  note("store isolation — names visible through the harness", names);
  return names;
}

/* ── Stage A: the wire ─────────────────────────────────────────────────── */

/** Open the SSE stream and collect frames with arrival timestamps. Returns
 *  null (with the reason recorded) when the route does not exist — which is
 *  precisely what the BEFORE tree reports. */
async function openStream(note) {
  const controller = new AbortController();
  let res;
  try {
    res = await fetch(`${API}/api/secrets/events`, {
      headers: { accept: "text/event-stream" },
      signal: controller.signal,
    });
  } catch (e) {
    note("stage A skipped — stream unreachable", String(e));
    return null;
  }
  if (!res.ok || !res.body) {
    note("stage A skipped — no event stream on this tree", { status: res.status });
    controller.abort();
    return null;
  }
  const frames = [];
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        // SSE frames are separated by a blank line; parse only whole ones.
        let idx;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const event = /^event:\s*(.*)$/m.exec(chunk)?.[1] ?? null;
          const data = /^data:\s*(.*)$/m.exec(chunk)?.[1] ?? null;
          frames.push({ at: Date.now(), event, data });
        }
      }
    } catch {
      /* aborted at the end of the protocol — expected */
    }
  })();
  return {
    frames,
    close: () => controller.abort(),
    /** Wait for the next frame of `event` after `since`, or null on timeout. */
    async next(event, since, timeoutMs = 10_000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const hit = frames.find((f) => f.event === event && f.at >= since);
        if (hit) return hit;
        if (Date.now() > deadline) return null;
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
}

async function stageA(check, note) {
  const stream = await openStream(note);
  if (!stream) {
    return { ran: false, reason: "no /api/secrets/events on this tree (BEFORE)" };
  }
  const hello = await stream.next("hello", 0, 5_000);
  check("A0 the stream says hello on connect", hello !== null, true);

  const name = NAME("wire");
  const latencies = [];

  // A1 — a store with NO flag must be silent. Checked FIRST, because a stream
  // that pushed on every write would make every later timing meaningless.
  const t0 = Date.now();
  await apiJson("POST", "/api/secrets", { name, value: PLACEHOLDER, note: "no flag here" });
  const spurious = await stream.next("request", t0, 2_500);
  check("A1 storing a secret WITHOUT for_konrad pushes nothing", spurious, null);

  // A2 — mark-pending, the U7 path the agents actually use.
  const t1 = Date.now();
  const marked = await apiJson("POST", `/api/secrets/${name}/mark-pending`, {
    requested_by_run_id: "3853c154-e07b-4378-9313-2b34f4a33342",
  });
  const t1Ack = Date.now();
  check("A2 mark-pending succeeded", marked.status, 200);
  const req = await stream.next("request", t1, 10_000);
  check("A2 …and a request frame arrived", req !== null, true);
  if (req) {
    latencies.push(req.at - t1Ack);
    const payload = JSON.parse(req.data);
    check("A2 the frame names the secret", payload.name, name);
    check("A2 the frame carries the requesting run", payload.requestedByRunId, "3853c154-e07b-4378-9313-2b34f4a33342");
    note("A2 mark-pending → frame (ms, after the POST was acked)", req.at - t1Ack);
  }

  // A3 — reveal clears it.
  const t2 = Date.now();
  await apiJson("POST", `/api/secrets/${name}/reveal`);
  const cleared = await stream.next("cleared", t2, 10_000);
  check("A3 revealing pushes a cleared frame", cleared !== null, true);
  if (cleared) note("A3 reveal → frame (ms)", cleared.at - t2);

  // A4 — a store WITH the flag is the other request path.
  const t3 = Date.now();
  await apiJson("POST", "/api/secrets", {
    name,
    value: PLACEHOLDER,
    note: NOTE("wire"),
    for_konrad: true,
  });
  const req2 = await stream.next("request", t3, 10_000);
  check("A4 storing WITH for_konrad pushes a request frame", req2 !== null, true);
  if (req2) {
    latencies.push(req2.at - t3);
    check("A4 …carrying the agent's own note", JSON.parse(req2.data).note, NOTE("wire"));
  }

  // A5 — delete clears it too.
  const t4 = Date.now();
  await apiJson("DELETE", `/api/secrets/${name}`);
  const cleared2 = await stream.next("cleared", t4, 10_000);
  check("A5 deleting pushes a cleared frame", cleared2 !== null, true);

  // A6 — THE SECURITY ASSERTION. No frame, of any kind, ever carried the
  // value. Checked over every frame seen in the whole stage, not just the
  // ones the assertions above looked at.
  const everyFrame = stream.frames.map((f) => f.data ?? "").join("\n");
  check("A6 no frame anywhere contained a secret value", everyFrame.includes(PLACEHOLDER), false);
  check("A6 …and none contained a `value` field", /"value"\s*:/.test(everyFrame), false);

  stream.close();
  return {
    ran: true,
    frames: stream.frames.map((f) => ({ event: f.event, data: f.data })),
    push_latency_ms: latencies,
  };
}

/* ── Stage B: what Konrad sees ─────────────────────────────────────────── */

async function stageB(check, note) {
  const samples = [];
  await withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    await openChat(page);
    // Settle: the composer's own mount fetch must be done before the clock
    // starts, or the first sample would measure the mount, not the push.
    await page.waitForTimeout(3_000);

    for (let i = 0; i < SAMPLES; i++) {
      const name = NAME(`b${i}`);
      const note_i = NOTE(`b${i}`);

      // The panel must be CLOSED before each sample, and stay closed until the
      // request lands — otherwise "it opened" proves nothing.
      const openBefore = await page.locator('textarea[placeholder^="paste the secret here"]').count();
      check(`B${i} the secret panel is closed before the agent asks`, openBefore, 0);

      // An agent files the request from outside the browser. `mark-pending`
      // needs the secret to exist first; the store call carries no flag, so it
      // cannot be what opens the panel.
      await apiJson("POST", "/api/secrets", { name, value: PLACEHOLDER, note: note_i });
      const t0 = Date.now();
      await apiJson("POST", `/api/secrets/${name}/mark-pending`, {
        requested_by_run_id: "3853c154-e07b-4378-9313-2b34f4a33342",
      });

      // 90 s ceiling: the polled tree's worst case is 60 s plus a fetch, and a
      // timeout must read as "longer than the poll", not as a dead protocol.
      let openedMs = null;
      try {
        await page.waitForSelector('textarea[placeholder^="paste the secret here"]', {
          timeout: 90_000,
        });
        openedMs = Date.now() - t0;
      } catch {
        openedMs = null;
      }
      check(`B${i} the panel opened by itself`, openedMs !== null, true);

      // …AND THE TEXT IS IN IT. "Opens up" without the agent's words is half
      // the requirement; this is the other half.
      const shownNote = await page
        .locator(`text=${note_i.slice(0, 40)}`)
        .first()
        .textContent()
        .catch(() => null);
      check(`B${i} the agent's request text is rendered in it`, shownNote !== null, true);

      note(`B${i} agent asked → panel open (ms)`, openedMs);
      samples.push({ sample: i, name, opened_ms: openedMs, note_rendered: shownNote !== null });

      // Reset for the next sample: dismiss on the server, close in the DOM.
      await apiJson("POST", `/api/secrets/${name}/clear-pending`);
      await apiJson("DELETE", `/api/secrets/${name}`);
      const closeBtn = page.getByText("not now", { exact: false }).first();
      if (await closeBtn.count()) await closeBtn.click().catch(() => {});
      await page.waitForTimeout(2_000);
    }
  });
  return samples;
}

async function main() {
  const { results, check, note, failed } = makeChecker();
  note("tree under test", LABEL);
  note("servers", { BASE, API, chat: CHAT_TEXT });
  const preexisting = await assertIsolatedStore(note);

  const a = await stageA(check, note);
  const b = await stageB(check, note);

  const opened = b.map((s) => s.opened_ms).filter((v) => v !== null);
  const summary = {
    label: LABEL,
    samples: b.length,
    opened_ms: opened,
    opened_ms_mean: opened.length
      ? Math.round(opened.reduce((x, y) => x + y, 0) / opened.length)
      : null,
    opened_ms_worst: opened.length ? Math.max(...opened) : null,
  };
  note("SUMMARY — agent asks → panel open", summary);

  finish(`secret-push-808-${LABEL}.json`, {
    label: LABEL,
    base: BASE,
    api: API,
    store_before_run: preexisting,
    stage_a_wire: a,
    stage_b_browser: b,
    summary,
    failures: failed(),
    results,
  }, failed());
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(2);
});
