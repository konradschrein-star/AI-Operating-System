/**
 * transcript-expand.cjs — U23, 14 §600: "ToolCallRow summaries expand to full
 * payloads byte-complete (no truncation in raw view)", plus the conservation
 * question round 602's fold raises: does anything DISAPPEAR?
 *
 * Three claims, over >=10 tool rows spanning >=3 distinct tools:
 *
 *  1. COLLAPSED == THE FORMATTER. Each row's collapsed line, read span by span,
 *     equals `summarizeTool`'s one-liner for that call — `label gist [fold chip]
 *     → outcome`. The expectation comes from `oracle-604.ts`, which imports the
 *     SHIPPED `thread-mapping.ts` + `tool-summary.ts`; a re-implementation here
 *     would only prove the re-implementation.
 *
 *  2. EXPANDED == THE PAYLOAD, BYTE FOR BYTE. The ARGS pane's text is compared
 *     to `meta.input` and the RESULT pane's to the matching tool_result's
 *     `content`, both fetched by THIS script straight from the harness API —
 *     the oracle is not in this path. Compared as sha256 AND length. Any
 *     difference of one byte is a FAIL; there is no tolerance and no "starts
 *     with" fallback, because a clip is exactly what this is looking for.
 *
 *     (What the payload IS can still be short: the executor stores `meta.input`
 *     clipped to 1500 chars + "…" for large arguments. That clip happens at the
 *     source, before anything in this repo sees it, and is documented in
 *     digest-gap.md. This protocol asserts the UI adds none of its own, and
 *     reports how many rows arrived pre-clipped so the number is not mistaken
 *     for a rendering result.)
 *
 *  3. COUNT CONSERVATION. `visible + folded + above + deeper === total` for the
 *     parent view, every fold chip's number equals the API's own count of
 *     entries stamped with that `parent_tool_use_id`, and the sub-agent view one
 *     descent down claims exactly that many of its own. So
 *     `parent visible + Σ folded slices === the run's full thread length`:
 *     nothing is hidden by the fold, it is one click away.
 *
 *     THE ENVELOPE IS COUNTED TWICE ON PURPOSE, and this script says so rather
 *     than hiding it: the spawn `tool_call` and its `tool_result` appear in the
 *     parent view (as the row you clicked) AND in the sub-agent view (as its
 *     brief and its report). `naive_sum` in the JSON is the sum with the overlap
 *     left in; `conserved` is the identity that actually holds.
 *
 * Run: see README.md §2.
 */

const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const {
  API,
  BASE,
  CHAT_TEXT,
  apiRun,
  finish,
  makeChecker,
  openChat,
  withBrowser,
} = require("./lib-604.cjs");

const REPO = path.join(__dirname, "..", "..", "..", "..");
const MIN_ROWS = 10;
const MIN_TOOLS = 3;

const sha = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function oracle(args) {
  const out = execFileSync(
    path.join(REPO, "forge-control", "node_modules", ".bin", "tsx"),
    [path.join(__dirname, "oracle-604.ts"), ...args],
    { cwd: path.join(REPO, "forge-control-web"), encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return JSON.parse(out);
}

/** The thread's own answer for one tool call, straight off the wire. */
function payloadOf(thread, toolUseId) {
  const call = thread.find(
    (e) => e.kind === "tool_call" && (e.meta ?? {}).tool_use_id === toolUseId,
  );
  const resultEntries = thread.filter(
    (e) => e.kind === "tool_result" && (e.meta ?? {}).tool_use_id === toolUseId,
  );
  if (call === undefined) return null;
  const meta = call.meta ?? {};
  return {
    args: typeof meta.input === "string" ? meta.input : String(call.content ?? ""),
    result: resultEntries.length === 0 ? null : String(resultEntries[0].content ?? ""),
    result_entries: resultEntries.length,
    /* The executor's own clip, applied before storage. Reported, not corrected. */
    pre_clipped_at_source: typeof meta.input === "string" && meta.input.endsWith("…"),
  };
}

/** Every tool row currently in the transcript, collapsed line included. */
const readRows = () =>
  Array.from(document.querySelectorAll("[data-tool-row]")).map((row, i) => {
    const header = row.firstElementChild;
    const parts = Array.from(header.children)
      .map((c) => (c.textContent ?? "").trim())
      .filter((t) => t !== "");
    const caret = parts[parts.length - 1];
    return {
      index: i,
      mode: row.getAttribute("data-tool-row"),
      collapsed: parts.slice(0, -1).join(" "),
      caret,
      fold: row.querySelector("[data-subagent-fold]")?.getAttribute("data-subagent-fold") ?? null,
      open: caret === "▾",
    };
  });

/** The two <pre> panes of one expanded row. */
const readPanes = (i) => {
  const row = document.querySelectorAll("[data-tool-row]")[i];
  const pres = Array.from(row.querySelectorAll("pre"));
  return {
    count: pres.length,
    args: pres[0]?.textContent ?? null,
    result: pres.length > 1 ? pres[1].textContent : null,
  };
};

async function walkRun(page, ctx, runId, check, note, label) {
  await page.locator(`[data-team-row][data-node-id="${runId}"]`).click();
  await page.waitForSelector("[data-agent-chat-view]", { timeout: 30_000 });
  await page.waitForFunction(
    () => document.querySelectorAll("[data-tool-row]").length > 0,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(2_500);

  const expected = oracle(["summaries", runId, API]);
  const run = await apiRun(runId);
  const rows = await page.evaluate(readRows);

  check(`${label} every tool row renders in SUMMARY mode`, [...new Set(rows.map((r) => r.mode))], ["summary"]);
  check(`${label} the DOM has exactly the mapper's tool-call parts`, rows.length, expected.tool_rows.length);
  const tools = [...new Set(expected.tool_rows.map((r) => r.tool))];
  note(`${label} distinct tools`, tools);
  if (rows.length < MIN_ROWS || tools.length < MIN_TOOLS)
    throw new Error(
      `${label}: ${rows.length} tool rows over ${tools.length} tools — the protocol needs >=${MIN_ROWS} rows and >=${MIN_TOOLS} tools. Pick another worker.`,
    );

  /* ── 1. collapsed == the formatter ──────────────────────────────────────── */
  const collapsedMismatches = [];
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].collapsed !== expected.tool_rows[i].collapsed)
      collapsedMismatches.push({ index: i, dom: rows[i].collapsed, formatter: expected.tool_rows[i].collapsed });
  }
  check(`${label} collapsed line == summarizeTool's one-liner, all ${rows.length} rows`, collapsedMismatches, []);

  /* ── 2. expanded == the payload, byte for byte ──────────────────────────── */
  const byteRows = [];
  const truncated = [];
  let preClipped = 0;
  for (let i = 0; i < rows.length; i++) {
    const meta = expected.tool_rows[i];
    const wire = payloadOf(run.thread, meta.tool_use_id);
    if (wire === null) {
      truncated.push({ index: i, why: `no tool_call entry with tool_use_id ${meta.tool_use_id}` });
      continue;
    }
    if (wire.pre_clipped_at_source) preClipped++;
    await page.evaluate((n) => {
      document.querySelectorAll("[data-tool-row]")[n].firstElementChild.click();
    }, i);
    await page.waitForTimeout(90);
    const panes = await page.evaluate(readPanes, i);

    const argsOk = panes.args !== null && sha(panes.args) === sha(wire.args);
    const resultOk =
      wire.result === null
        ? panes.result === null
        : panes.result !== null && sha(panes.result) === sha(wire.result);
    if (!argsOk || !resultOk)
      truncated.push({
        index: i,
        tool: meta.tool,
        tool_use_id: meta.tool_use_id,
        args: { dom_len: panes.args?.length ?? null, api_len: wire.args.length, sha_match: argsOk },
        result: {
          dom_len: panes.result?.length ?? null,
          api_len: wire.result?.length ?? null,
          sha_match: resultOk,
        },
      });
    byteRows.push({
      index: i,
      tool: meta.tool,
      args_len: wire.args.length,
      args_sha: sha(wire.args).slice(0, 12),
      dom_args_len: panes.args?.length ?? null,
      result_len: wire.result?.length ?? null,
      result_sha: wire.result === null ? null : sha(wire.result).slice(0, 12),
      dom_result_len: panes.result?.length ?? null,
      multiple_results: wire.result_entries,
    });
    /* Collapse it again so the next expansion is measured on its own. */
    await page.evaluate((n) => {
      document.querySelectorAll("[data-tool-row]")[n].firstElementChild.click();
    }, i);
  }
  check(`${label} expanded ARGS/RESULT are byte-identical to the API payload`, truncated, []);
  note(`${label} bytes compared`, {
    rows: byteRows.length,
    args_bytes: byteRows.reduce((a, r) => a + r.args_len, 0),
    result_bytes: byteRows.reduce((a, r) => a + (r.result_len ?? 0), 0),
    rows_whose_meta_input_the_EXECUTOR_clipped_before_storage: preClipped,
  });

  /* ── 3. count conservation ──────────────────────────────────────────────── */
  const cov = expected.coverage;
  check(`${label} coverage arithmetic holds (visible+folded+above+deeper===total)`, cov.ok, true);
  check(`${label} the thread this view accounts for is the whole run`, cov.total, run.thread.length);

  const foldReports = [];
  for (const fold of expected.folds) {
    const apiInner = run.thread.filter(
      (e) => (e.meta ?? {}).parent_tool_use_id === fold.subagent_id,
    ).length;
    const envelope = run.thread.filter(
      (e) => (e.meta ?? {}).parent_tool_use_id == null && (e.meta ?? {}).tool_use_id === fold.subagent_id,
    ).length;
    const domChip = rows.find((r) => r.fold === fold.subagent_id);
    foldReports.push({
      subagent_id: fold.subagent_id,
      chip_event_count: fold.event_count,
      api_entries_with_this_parent: apiInner,
      envelope_entries: envelope,
      chip_on_screen: domChip?.collapsed ?? null,
    });
    check(
      `${label} fold chip ${fold.subagent_id.slice(0, 12)} == the API's own count`,
      fold.event_count,
      apiInner,
    );

    /* One descent down: the sub-agent's view, and what IT claims. */
    await page.locator(`[data-team-row][data-node-id="${fold.subagent_id}"]`).click().catch(() => {});
    await page.waitForTimeout(3_000);
    const descended = await page.evaluate(() => ({
      depth: Number(document.querySelector("[data-agent-chat-view]")?.getAttribute("data-depth") ?? 0),
      subagentId: document.querySelector("[data-agent-chat-view]")?.getAttribute("data-subagent-id") ?? null,
      note: Array.from(document.querySelectorAll("[data-agent-chat-view] .mono"))
        .map((e) => (e.textContent ?? "").trim())
        .find((t) => /entries? —/.test(t) || /^\d+ entries/.test(t)) ?? null,
      toolRows: document.querySelectorAll("[data-tool-row]").length,
    }));
    const childCov = oracle(["subagent", runId, fold.subagent_id, API]).coverage;
    check(`${label} descending on the chip reaches that sub-agent`, descended.subagentId, fold.subagent_id);
    check(
      `${label} the child view sees its slice plus the envelope, and nothing else`,
      childCov.visible,
      apiInner + envelope,
    );
    check(
      `${label} CONSERVED: parent visible + this slice === the run's thread length`,
      cov.visible + apiInner,
      run.thread.length,
    );
    foldReports[foldReports.length - 1].child_view = {
      coverage: childCov,
      slice_note_on_screen: descended.note,
      tool_rows: descended.toolRows,
      naive_sum_with_envelope_double_counted: cov.visible + childCov.visible,
      conserved_sum: cov.visible + apiInner,
      thread_length: run.thread.length,
    };
    await page.locator("[data-nav-back]").click();
    await page.waitForTimeout(2_000);
  }

  await page.locator("[data-nav-back]").click();
  await page.waitForTimeout(2_500);

  return {
    run_id: runId,
    status: run.status,
    thread_length: run.thread.length,
    tools,
    tool_rows: rows.length,
    coverage: cov,
    folds: foldReports,
    bytes: byteRows,
    pre_clipped_at_source: preClipped,
  };
}

async function main() {
  const { results, check, note, failed } = makeChecker();

  const payload = await withBrowser(async (ctx) => {
    const page = await ctx.newPage();
    await openChat(page);

    /* Two workers, chosen at run time for what they can prove, not by id:
     *  · the only worker in this chat's tree that owns a sub-agent (fold +
     *    conservation), and
     *  · the worker with the most distinct tools (volume + formatter coverage).
     * Both are clicked in the real tree; nothing is injected in this protocol. */
    const rows = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-team-row][data-kind="worker"]')).map((r) => r.getAttribute("data-node-id")),
    );
    const subParents = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("[data-team-row]"));
      const out = [];
      all.forEach((r, i) => {
        if (r.getAttribute("data-kind") !== "subagent" || r.getAttribute("data-depth") !== "2") return;
        for (let j = i - 1; j >= 0; j--)
          if (all[j].getAttribute("data-kind") === "worker") return out.push(all[j].getAttribute("data-node-id"));
      });
      return [...new Set(out)];
    });
    if (subParents.length === 0)
      throw new Error("NO-FOLD-FIXTURE — no worker in this tree owns a sub-agent, so conservation has nothing to conserve");

    /* Widest tool mix, measured from the API rather than guessed. */
    let widest = null;
    for (const id of rows) {
      const run = await apiRun(id);
      const tools = new Set(
        run.thread
          .filter((e) => e.kind === "tool_call" && (e.meta ?? {}).parent_tool_use_id == null)
          .map((e) => (e.meta ?? {}).tool),
      );
      const calls = run.thread.filter(
        (e) => e.kind === "tool_call" && (e.meta ?? {}).parent_tool_use_id == null,
      ).length;
      if (widest === null || tools.size > widest.tools || (tools.size === widest.tools && calls > widest.calls))
        widest = { id, tools: tools.size, calls };
    }
    note("fixture: fold/conservation worker", subParents[0]);
    note("fixture: widest tool mix", widest);

    const a = await walkRun(page, ctx, subParents[0], check, note, "[fold]");
    const b =
      widest.id === subParents[0] ? null : await walkRun(page, ctx, widest.id, check, note, "[wide]");

    const allTools = [...new Set([...a.tools, ...(b?.tools ?? [])])];
    const allRows = a.tool_rows + (b?.tool_rows ?? 0);
    check(`>=${MIN_ROWS} tool rows measured in total`, allRows >= MIN_ROWS, true);
    check(`>=${MIN_TOOLS} distinct tools measured in total`, allTools.length >= MIN_TOOLS, true);
    note("total rows measured", allRows);
    note("total distinct tools", allTools);

    return {
      base: BASE,
      api: API,
      chat: CHAT_TEXT,
      navigation: "real — both workers reached by clicking their team row",
      runs: [a, b].filter(Boolean),
      totals: { rows: allRows, tools: allTools },
    };
  });

  finish("transcript-expand.json", { ...payload, failures: failed(), results }, failed());
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(2);
});
