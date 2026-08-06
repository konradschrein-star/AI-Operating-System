/**
 * nav-walk-700.cjs — the U26 click-through, walked end to end on real data,
 * plus the error path. Successor to phase600's `nav-walk.cjs`, same posture:
 * open the chat the way a person does, click what a person clicks, assert on
 * what the DOM actually says rather than on what the component was meant to do.
 *
 * THE WALK
 *   1. open the fixture chat; both zones reach `ready`
 *   2. the Kanban's blocks are EXACTLY the endpoint's blocks — every
 *      `round_base`, in order, with its own done/total, not a count of cards
 *   3. click a `docs[]` entry
 *   4. `[data-plan-doc-view][data-doc-state="ready"]` carries that file name AND
 *      REAL RENDERED MARKDOWN. Non-empty text is not the assertion: a 404 body
 *      pasted into a <div> is non-empty text. The assertion is STRUCTURE —
 *      `MessageMarkdown` maps `#`/`##` onto real `<h1>`/`<h2>` elements
 *      (MessageMarkdown.tsx:33-58), so an `h1` or `h2` INSIDE the doc view,
 *      whose text matches the document's own first heading, is what proves the
 *      markdown pipeline ran rather than a string being dumped.
 *   5. back → the manager chat, and THE PANEL NEVER RE-SCOPED (10 §"Right
 *      sidebar"): the manager row's node id is the same chat both before and
 *      after, and no row that was in the tree has left it.
 *   6. the ERROR PATH: a doc frame for a name the server will refuse. The
 *      rendered error must carry THE SERVER'S OWN SENTENCE — the exact string
 *      `resolvePlanDoc` produced (chat.ts: `no such plan document: <name>`),
 *      not "something went wrong" and not a bare status line. Then back must
 *      still work, because an error state that traps the reader is a worse bug
 *      than the error.
 *
 * ── The one interception in this round, declared ──────────────────────────
 * Step 6 needs a doc frame for a file that does not exist, and the zone only
 * renders names the server listed — by design (PlanKanban.tsx: a dead click
 * that opens nothing is a FAIL). So this script routes ONE response,
 * `GET /api/proxy/chat/:id/plan`, and appends one bogus name to its `docs[]`.
 * That is the whole intervention:
 *
 *   - `/api/proxy/chat/:id/plan/doc` is NOT intercepted. The 404 and its
 *     sentence are the real server's, produced by the real containment code.
 *   - the route is installed only for step 6 and removed after, so steps 1-5
 *     ran against an untouched response.
 *   - the alternative — writing a file into the project's docs/plan/ and
 *     deleting it — is a mutation of a live workspace from a build task, which
 *     this project's rules forbid.
 *
 * Run:
 *   PHASE700_BASE_URL=http://127.0.0.1:7809 \
 *   FORGE_SESSION_COOKIE="$(cat /tmp/session-cookie-703.txt)" \
 *     node docs/plan/artifacts/phase700/nav-walk-700.cjs
 */

const {
  API,
  BASE,
  finish,
  makeChecker,
  openChat,
  resolveChat,
  api,
  waitForAttr,
  watchErrors,
  withBrowser,
} = require("./lib-703.cjs");

const { results, check, note, failed } = makeChecker();

/** A name that cannot exist and cannot be mistaken for a typo of one that can.
 *  `.md` on purpose: the 400 branch (`only .md documents are served`) is a
 *  DIFFERENT code path, already covered by linkage-701.md §4c against the
 *  endpoint. What is unproven until now is the 404 reaching the READER. */
const BOGUS_DOC = "zz-no-such-plan-doc-703.md";

/** Everything both zones say, in one `evaluate` so a 5s team poll or a 15s plan
 *  poll cannot slide between two readings of the same moment. */
async function readSurface(page) {
  return page.evaluate(() => {
    const doc = document.querySelector("[data-plan-doc-view]");
    const body = doc?.querySelector("[data-doc-state]") ?? null;
    return {
      plan_state: document.querySelector("[data-plan-kanban]")?.getAttribute("data-plan-state") ?? null,
      plan_progress:
        document.querySelector("[data-plan-kanban]")?.getAttribute("data-plan-progress") ?? null,
      phase_cards: Array.from(document.querySelectorAll("[data-plan-phase]")).map((c) => ({
        round_base: Number(c.getAttribute("data-plan-phase")),
        progress: c.getAttribute("data-plan-phase-progress"),
      })),
      doc_links: Array.from(document.querySelectorAll("[data-plan-docs] [data-plan-doc]")).map((b) =>
        b.getAttribute("data-plan-doc"),
      ),
      team_state: document.querySelector("[data-team-panel]")?.getAttribute("data-team-state") ?? null,
      team_rows: Array.from(document.querySelectorAll("[data-team-row]")).map((r) => ({
        id: r.getAttribute("data-node-id"),
        kind: r.getAttribute("data-kind"),
      })),
      doc_view: doc
        ? {
            name: doc.getAttribute("data-doc-name"),
            depth: Number(doc.getAttribute("data-depth")),
            state: body?.getAttribute("data-doc-state") ?? null,
            title: doc.querySelector("[data-doc-title]")?.textContent ?? null,
            crumbs: doc.querySelector("[data-nav-crumbs]")?.textContent ?? null,
            back_label: doc.querySelector("[data-nav-back]")?.textContent?.trim() ?? null,
            /* STRUCTURE, not text. Every heading element the markdown renderer
             * produced, in document order, with its tag — this is what tells a
             * 200 markdown body apart from an error string in a <div>. */
            headings: Array.from(body?.querySelectorAll("h1, h2, h3") ?? []).map((h) => ({
              tag: h.tagName.toLowerCase(),
              text: (h.textContent ?? "").trim().slice(0, 120),
            })),
            paragraphs: body?.querySelectorAll("p").length ?? 0,
            body_text: (body?.textContent ?? "").trim().slice(0, 400),
          }
        : null,
      /* The manager chat is what depth 0 looks like: no drilled view at all. */
      agent_view: document.querySelector("[data-agent-chat-view]") !== null,
      composer: document.querySelector("textarea") !== null,
    };
  });
}

/** The doc body's own first heading, taken from the RAW markdown the endpoint
 *  serves — so the DOM assertion in step 4 compares against the file, not
 *  against a hard-coded string that would go stale with the corpus. */
async function firstHeadingOf(chatId, name) {
  const r = await fetch(`${API}/api/chat/${chatId}/plan/doc?name=${encodeURIComponent(name)}`);
  if (!r.ok) throw new Error(`GET /plan/doc?name=${name} → ${r.status} (fixture doc unreadable)`);
  const text = await r.text();
  const line = text.split("\n").find((l) => /^#{1,3}\s+\S/.test(l));
  if (!line) throw new Error(`fixture doc ${name} has no ATX heading — pick another fixture`);
  return {
    tag: `h${line.match(/^#+/)[0].length}`,
    text: line.replace(/^#+\s+/, "").trim(),
    bytes: text.length,
  };
}

async function main() {
  const chatRow = await resolveChat();
  note("chat", { id: chatRow.id, title: chatRow.title });

  const plan = await api(`/api/chat/${chatRow.id}/plan`);
  const expectedBlocks = plan.phases.map((p) => ({
    round_base: p.round_base,
    progress: `${p.tasks.filter((t) => t.status === "done").length}/${p.tasks.length}`,
  }));
  note("endpoint blocks", expectedBlocks.map((b) => `${b.round_base}:${b.progress}`).join(" "));

  /* The fixture doc: the last of the corpus, as round 702 used, so the two
   * rounds' captures are comparable. Its heading is read from the file. */
  const target = plan.docs[plan.docs.length - 1];
  const heading = await firstHeadingOf(chatRow.id, target);
  note("fixture doc", { name: target, ...heading });

  await withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    const errs = watchErrors(page);

    /* ── 1-2: open, and the blocks are the endpoint's blocks ─────────────── */
    await openChat(page);
    const opened = await readSurface(page);
    note("on open", {
      plan_state: opened.plan_state,
      progress: opened.plan_progress,
      cards: opened.phase_cards.length,
      docs: opened.doc_links.length,
      team_rows: opened.team_rows.length,
    });
    check("kanban blocks == endpoint blocks (base and done/total, in order)", opened.phase_cards, expectedBlocks);
    check("docs list == endpoint docs[]", opened.doc_links, plan.docs);
    check("team zone ready beside the plan zone", opened.team_state, "ready");
    check("no drilled view at depth 0", opened.agent_view || opened.doc_view !== null, false);

    /* The manager row is the chat's own run. This is the identity the whole
     * "never re-scope" assertion hangs on, so it is located BY ID and its kind
     * is then asserted — not located by kind, which is how this script was
     * first written and how it first failed. The wire's vocabulary is
     * `operator` for the chat's own run and `worker`/`subagent` beneath it
     * (routes/chat.ts's team response; there is no `manager` kind, only a
     * `manager` FIELD holding the operator node). Recorded here because the
     * word "manager" is used for the surface everywhere else in this corpus. */
    const managerBefore = opened.team_rows.find((r) => r.id === chatRow.id);
    note("team row kind vocabulary", [...new Set(opened.team_rows.map((r) => r.kind))]);
    check("the chat's own run is a row in its team tree", managerBefore?.id, chatRow.id);
    check("and it is the operator row", managerBefore?.kind, "operator");

    /* ── 3-4: click a docs[] entry, assert RENDERED MARKDOWN ─────────────── */
    await page.click(`[data-plan-docs] [data-plan-doc="${target}"]`);
    await page.waitForSelector("[data-plan-doc-view]", { timeout: 15_000 });
    await waitForAttr(page, "[data-plan-doc-view] [data-doc-state]", "data-doc-state", "ready", 20_000);
    const drilled = await readSurface(page);
    const dv = drilled.doc_view;
    note("plan doc view", {
      name: dv.name,
      state: dv.state,
      depth: dv.depth,
      headings: dv.headings.length,
      paragraphs: dv.paragraphs,
      first_heading: dv.headings[0],
      crumbs: dv.crumbs,
      back_label: dv.back_label,
    });
    check("the frame opened the file that was clicked", dv.name, target);
    check("doc state is ready", dv.state, "ready");
    check("the header names the file", dv.title, target);
    check("nav depth is 1", dv.depth, 1);
    /* THE STRUCTURAL ASSERTION. Not "text is non-empty" — a real heading
     * ELEMENT, of the tag the source's own `#`-run implies, carrying the
     * source's own words. */
    check("markdown produced a real heading element", dv.headings[0]?.tag, heading.tag);
    check("that heading is the document's own first heading", dv.headings[0]?.text, heading.text);
    check("the body has more than one heading (a document, not a line)", dv.headings.length > 1, true);
    check("the body has rendered paragraphs", dv.paragraphs > 0, true);
    /* The panel must not move when the MIDDLE surface changes (U20). */
    check("team zone unmoved by the drill-in", drilled.team_state, "ready");
    check("plan zone unmoved by the drill-in", drilled.plan_state, "ready");

    /* ── 5: back, and the panel never re-scoped ──────────────────────────── */
    await page.click("[data-plan-doc-view] [data-nav-back]");
    await page.waitForTimeout(1_500);
    const popped = await readSurface(page);
    check("back closed the doc view", popped.doc_view, null);
    check("back landed on the manager chat, not an agent view", popped.agent_view, false);
    check("the composer is back", popped.composer, true);
    check("plan zone survives the pop", popped.plan_state, "ready");
    check("team zone survives the pop", popped.team_state, "ready");

    const managerAfter = popped.team_rows.find((r) => r.id === chatRow.id);
    check("the operator row is still THIS chat — the panel did not re-scope", managerAfter?.kind, "operator");
    /* Rows may be ADDED between the two reads: this project is running, and a
     * sub-agent that starts mid-walk is a real row appearing, not a re-scope.
     * A row LEAVING the tree is the thing that would mean the panel had been
     * pointed somewhere else, so that is what is asserted. Any addition is
     * reported so a reviewer sees the churn rather than having it smoothed. */
    const before = opened.team_rows.map((r) => r.id);
    const after = popped.team_rows.map((r) => r.id);
    const lost = before.filter((id) => !after.includes(id));
    const gained = after.filter((id) => !before.includes(id));
    note("team row churn across the walk", { before: before.length, after: after.length, gained });
    check("no team row was lost across the drill-in and back", lost, []);

    /* ── 6: the error path ───────────────────────────────────────────────── */
    let interceptedOnce = 0;
    await ctx.route("**/api/proxy/chat/*/plan", async (route) => {
      const response = await route.fetch();
      let body;
      try {
        body = await response.json();
      } catch {
        return route.fulfill({ response });
      }
      if (!Array.isArray(body?.docs)) return route.fulfill({ response });
      interceptedOnce += 1;
      body.docs = [...body.docs, BOGUS_DOC];
      return route.fulfill({ response, body: JSON.stringify(body) });
    });
    /* Force the next poll now rather than waiting 15s for it. */
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.waitForSelector(`[data-plan-docs] [data-plan-doc="${BOGUS_DOC}"]`, { timeout: 30_000 });
    note("bogus doc injected into docs[]", { name: BOGUS_DOC, plan_responses_rewritten: interceptedOnce });

    await page.click(`[data-plan-docs] [data-plan-doc="${BOGUS_DOC}"]`);
    await page.waitForSelector("[data-plan-doc-view]", { timeout: 15_000 });
    await waitForAttr(page, "[data-plan-doc-view] [data-doc-state]", "data-doc-state", "error", 20_000);
    const errored = await readSurface(page);
    const ev = errored.doc_view;
    note("error state", { name: ev.name, state: ev.state, body: ev.body_text, headings: ev.headings.length });

    /* The endpoint's own sentence, fetched here so the expected string is the
     * server's, not this file's idea of the server's. */
    const raw = await fetch(
      `${API}/api/chat/${chatRow.id}/plan/doc?name=${encodeURIComponent(BOGUS_DOC)}`,
    );
    const serverBody = await raw.json();
    note("server said", { status: raw.status, ...serverBody });
    check("the endpoint refuses the bogus name with 404", raw.status, 404);
    check("the error frame carries the bogus name", ev.name, BOGUS_DOC);
    check("the rendered error IS the server's own sentence", ev.body_text, serverBody.error);
    check("no markdown was rendered in the error state", ev.headings.length, 0);

    /* An error state that traps the reader is worse than the error. */
    check("the back button is still there in the error state", ev.back_label !== null, true);
    await page.click("[data-plan-doc-view] [data-nav-back]");
    await page.waitForTimeout(1_500);
    const recovered = await readSurface(page);
    check("back works out of the error state", recovered.doc_view, null);
    check("the composer is back after the error", recovered.composer, true);
    check("plan zone survives the error round trip", recovered.plan_state, "ready");
    check(
      "the operator row is STILL this chat after the error round trip",
      recovered.team_rows.find((r) => r.id === chatRow.id)?.kind,
      "operator",
    );

    await ctx.unroute("**/api/proxy/chat/*/plan");

    note("failed requests", errs.failedRequests);
    note("ignored console lines (pre-existing — see lib-703.cjs:watchErrors)", errs.ignored);
    /* The bogus doc's own 404 is EXPECTED — it is the thing step 6 asked for.
     * It is named explicitly rather than filtered by pattern, so a second,
     * unexpected 404 could never hide behind the same rule. */
    const unexpected = errs.consoleErrors.filter((l) => !l.includes(BOGUS_DOC));
    check("console errors other than the deliberate 404", unexpected, []);
  });

  finish(
    "nav-walk-700.json",
    {
      base: BASE,
      api: API,
      chat: { id: chatRow.id, title: chatRow.title },
      fixture_doc: { name: target, ...heading },
      bogus_doc: BOGUS_DOC,
      expected_blocks: expectedBlocks,
      results,
      verdict: failed() === 0 ? "PASS" : "FAIL",
    },
    failed(),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
