/**
 * digest-honesty.cjs — U24, 14 §600: "digest honesty on a 200-entry real
 * session".
 *
 * The digest is a block of numbers and quotations sitting above a transcript
 * nobody will scroll. Its whole value is that it is TRUE, so every number on
 * screen is re-derived HERE, from the API's own thread, with arithmetic written
 * in this file — `deriveDigest` is never called and `story-digest.ts` is never
 * imported. Checking a digest against the function that produced it would be
 * checking that function against itself.
 *
 * Asserted, on a session of >=200 entries discovered at run time:
 *
 *  · entries, its own, delegated, tool calls, tool errors, sub-agents, and the
 *    role list — each counted from `GET /api/chat/:id`'s thread by this script;
 *  · the collapsed header's numbers agree with the expanded block's;
 *  · TIME is FROZEN for a settled run (`data-story-elapsed="frozen"`), and the
 *    rendered duration is consistent with `completed_at − started_at` — parsed
 *    BACK out of the string to a millisecond range rather than re-implementing
 *    the formatter;
 *  · EVERY quoted snippet is a VERBATIM substring of a real thread entry, found
 *    by search over the whole thread — not "looks like", not "starts with the
 *    same 20 characters". A clipped snippet is matched with its "…" removed and
 *    must still be a prefix of the entry it claims to quote;
 *  · the same for the WHERE IT STANDS outcome;
 *  · the snippets are the LAST prose turns in scope, in thread order, and not
 *    some other three.
 *
 * TWO FIXTURES, because no single run today exercises the whole block:
 *
 *  [big]    the largest thread in the fleet (>=200 entries, the brief's bar).
 *           Reached through an injected team row — no chat in this database has
 *           a >=200-entry run in its team (lib-604.cjs explains why).
 *  [roster] a worker with a real sub-agent, reached by CLICKING its team row.
 *           It is smaller, and it is the only way to exercise the sub-agent
 *           roster against live data: not one >=200-entry run in this database
 *           has a sub-agent. That gap is a finding, and it is in the README.
 *
 * Run: see README.md §2.
 */

const {
  API,
  BASE,
  CHAT_TEXT,
  api,
  apiRun,
  finish,
  injectTeamRow,
  makeChecker,
  openChat,
  withBrowser,
} = require("./lib-604.cjs");

const MIN_ENTRIES = 200;
const DIGEST_SNIPPETS = 3; // story-digest.ts DIGEST_SNIPPETS
const SNIPPET_MAX = 160; // story-digest.ts SNIPPET_MAX
const OUTCOME_MAX = 240; // story-digest.ts OUTCOME_MAX
const SPAWN_TOOLS = new Set(["Agent", "Task"]);

/* ── The counts, re-derived from the wire ─────────────────────────────────── */

const parentOf = (e) => {
  const v = (e.meta ?? {}).parent_tool_use_id;
  return typeof v === "string" && v !== "" ? v : null;
};
const toolUseIdOf = (e) => {
  const v = (e.meta ?? {}).tool_use_id;
  return typeof v === "string" && v !== "" ? v : null;
};
const isProse = (e) =>
  (e.role === "assistant" || e.role === "agent") &&
  (e.kind === undefined || e.kind === "text") &&
  typeof e.content === "string" &&
  e.content.trim() !== "";
const isErrorEntry = (e) => e.kind === "error" || (e.meta ?? {}).is_error === true;

/** Everything the digest claims, computed independently. */
function rederive(run) {
  const thread = run.thread;
  const topLevel = thread.filter((e) => parentOf(e) === null);
  const proseScope = topLevel.length > 0 ? "top-level" : "slice";
  const scope = proseScope === "top-level" ? topLevel : thread;

  /* roster: declared sub-agents joined to the ones with entries, minus a
   * slice's own owner — subagent-slice.ts:69-91 and 278-328, restated. */
  const index = new Map();
  for (const e of thread) {
    const p = parentOf(e);
    if (p === null) continue;
    index.set(p, (index.get(p) ?? 0) + 1);
  }
  const spawnedHere = new Set(
    thread
      .filter((e) => e.kind === "tool_call" && SPAWN_TOOLS.has((e.meta ?? {}).tool))
      .map(toolUseIdOf)
      .filter((id) => id !== null),
  );
  const owner = topLevel.length > 0 ? null : parentOf(thread[0] ?? {});
  const declared = Array.isArray((run.metadata ?? {}).subagents_v2)
    ? run.metadata.subagents_v2.filter((s) => s && typeof s.tool_use_id === "string")
    : [];
  const roster = [];
  const seen = new Set();
  for (const d of declared) {
    if (seen.has(d.tool_use_id)) continue;
    seen.add(d.tool_use_id);
    const sliceCount = index.get(d.tool_use_id) ?? 0;
    if (d.tool_use_id === owner) continue;
    if (sliceCount === 0 && !spawnedHere.has(d.tool_use_id)) continue;
    roster.push({ id: d.tool_use_id, role: typeof d.role === "string" && d.role ? d.role : null });
  }
  for (const [id] of index) {
    if (seen.has(id) || id === owner) continue;
    seen.add(id);
    if ((index.get(id) ?? 0) === 0 && !spawnedHere.has(id)) continue;
    roster.push({ id, role: null });
  }
  for (const id of spawnedHere) {
    if (seen.has(id)) continue;
    seen.add(id);
    roster.push({ id, role: null });
  }
  const roles = [];
  for (const s of roster) {
    const r = s.role ?? "unknown";
    if (!roles.includes(r)) roles.push(r);
  }

  const prose = scope.filter(isProse);
  const clip = (t, max) =>
    t.length <= max ? { text: t.trim(), clipped: false } : { text: `${t.slice(0, max).trimEnd()}…`, clipped: true };
  const snippets = prose.slice(-DIGEST_SNIPPETS).map((e) => ({
    ts: typeof e.ts === "string" ? e.ts : "",
    ...clip(e.content, SNIPPET_MAX),
    source: e.content,
  }));
  const last = prose.length > 0 ? prose[prose.length - 1] : null;

  const settled = ["completed", "failed", "cancelled"].includes(run.status);
  const startedMs = run.started_at ? Date.parse(run.started_at) : NaN;
  const completedMs = run.completed_at ? Date.parse(run.completed_at) : NaN;
  const elapsedMs =
    settled && Number.isFinite(startedMs) && Number.isFinite(completedMs) && completedMs >= startedMs
      ? completedMs - startedMs
      : null;

  return {
    entry_count: thread.length,
    top_level_count: topLevel.length,
    subagent_entry_count: thread.length - topLevel.length,
    tool_call_count: thread.filter((e) => e.kind === "tool_call").length,
    error_count: thread.filter(isErrorEntry).length,
    subagent_count: roster.length,
    subagent_roles: roles,
    prose_scope: proseScope,
    prose_turns: prose.length,
    snippets,
    outcome: last === null ? null : clip(last.content, OUTCOME_MAX).text,
    outcome_source_entry: last === null ? null : last.content,
    settled,
    elapsed_ms: elapsedMs,
    status: run.status,
    title: run.title ?? null,
  };
}

/** "1h 04m" / "12m 07s" / "42s" → milliseconds, and the unit it was rounded to. */
function parseDuration(text) {
  const m = /(?:(\d+)h\s+)?(?:(\d+)m\s*)?(?:(\d+)s)?/.exec(text.trim());
  if (m === null) return null;
  const [, h, min, s] = m;
  if (h === undefined && min === undefined && s === undefined) return null;
  const ms = (Number(h ?? 0) * 3600 + Number(min ?? 0) * 60 + Number(s ?? 0)) * 1000;
  /* fmtWorkingTime drops seconds above an hour and drops nothing below a
   * minute, so the tolerance is the smallest unit actually printed. */
  const tolerance = h !== undefined ? 60_000 : s !== undefined ? 1_000 : 60_000;
  return { ms, tolerance };
}

/* ── DOM ──────────────────────────────────────────────────────────────────── */

const readDigest = () => {
  const root = document.querySelector("[data-story-so-far]");
  if (root === null) return null;
  const header = root.firstElementChild;
  const body = root.children[1] ?? null;
  const sectionText = (label) => {
    if (body === null) return null;
    const blocks = Array.from(body.children);
    for (const b of blocks) {
      const head = (b.firstElementChild?.textContent ?? "").trim();
      if (head.startsWith(label)) return (b.children[1]?.textContent ?? "").trim();
    }
    return null;
  };
  const workCounts = (() => {
    if (body === null) return [];
    for (const b of Array.from(body.children)) {
      if ((b.firstElementChild?.textContent ?? "").trim().startsWith("WORK"))
        return Array.from(b.children[1]?.children ?? []).map((c) => (c.textContent ?? "").trim());
    }
    return [];
  })();
  return {
    open: root.getAttribute("data-story-open"),
    header: Array.from(header.children)
      .map((c) => (c.textContent ?? "").trim())
      .filter((t) => t !== ""),
    work: workCounts,
    task: sectionText("TASK"),
    time: sectionText("TIME"),
    elapsedMarker:
      root.querySelector("[data-story-elapsed]")?.getAttribute("data-story-elapsed") ?? null,
    elapsedText: root.querySelector("[data-story-elapsed]")?.textContent?.trim() ?? null,
    snippets: Array.from(root.querySelectorAll("[data-story-snippet]")).map((s) => ({
      clipped: s.getAttribute("data-story-snippet"),
      ts: (s.children[0]?.textContent ?? "").trim(),
      text: (s.children[1]?.textContent ?? "").trim(),
    })),
    outcomeLabel: (() => {
      if (body === null) return null;
      for (const b of Array.from(body.children)) {
        const head = (b.firstElementChild?.textContent ?? "").trim();
        if (head.startsWith("WHERE IT STANDS")) return head;
      }
      return null;
    })(),
    outcome: sectionText("WHERE IT STANDS"),
    gapDoc: root.querySelector("[data-story-gap-doc]")?.textContent ?? null,
  };
};

/** `N label` out of a Count span, as a number. */
function countIn(list, label) {
  const hit = list.find((t) => t === label || t.endsWith(` ${label}`) || t.startsWith(`${label} `) || new RegExp(`^-?\\d[\\d,]*\\s+${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`).test(t));
  if (hit === undefined) return null;
  const m = /^(-?\d[\d,]*)\s+/.exec(hit);
  return m === null ? null : Number(m[1].replace(/,/g, ""));
}

async function measure(page, runId, label, check, note) {
  await page.locator(`[data-team-row][data-node-id="${runId}"]`).click();
  await page.waitForSelector("[data-agent-chat-view]", { timeout: 30_000 });
  await page.waitForSelector("[data-story-so-far]", { timeout: 30_000 });
  await page.waitForTimeout(2_000);

  const collapsed = await page.evaluate(readDigest);
  check(`${label} the digest opens collapsed (U24)`, collapsed.open, "0");
  await page.locator("[data-story-toggle]").click();
  await page.waitForTimeout(800);
  const dom = await page.evaluate(readDigest);
  check(`${label} it expands`, dom.open, "1");

  const run = await apiRun(runId);
  const truth = rederive(run);

  /* ── counts ───────────────────────────────────────────────────────────── */
  const pairs = [
    ["entries", truth.entry_count],
    ["tool calls", truth.tool_call_count],
    ["tool errors", truth.error_count],
    ["sub-agents", truth.subagent_count],
  ];
  for (const [name, expected] of pairs)
    check(`${label} WORK "${name}" == re-derived from the API thread`, countIn(dom.work, name), expected);

  if (truth.prose_scope === "top-level") {
    check(`${label} WORK "its own" == entries with no parent_tool_use_id`, countIn(dom.work, "its own"), truth.top_level_count);
    check(`${label} WORK "delegated" == entries that have one`, countIn(dom.work, "delegated"), truth.subagent_entry_count);
  }
  check(
    `${label} the collapsed header's entry count matches the expanded block`,
    countIn(dom.header, "entries"),
    truth.entry_count,
  );
  check(
    `${label} the collapsed header's tool-call count matches too`,
    countIn(dom.header, "tool calls"),
    truth.tool_call_count,
  );
  if (truth.subagent_roles.length > 0)
    check(
      `${label} the sub-agent roles listed are the roles the thread/rollup name`,
      dom.work.includes(truth.subagent_roles.join(", ")),
      true,
    );

  /* ── time ─────────────────────────────────────────────────────────────── */
  check(
    `${label} a settled run's duration is marked FROZEN`,
    dom.elapsedMarker,
    truth.settled && truth.elapsed_ms !== null ? "frozen" : "live",
  );
  let durationReport = null;
  if (truth.settled && truth.elapsed_ms !== null) {
    const parsed = parseDuration((dom.elapsedText ?? "").replace(/^ran\s+/, ""));
    durationReport = { rendered: dom.elapsedText, parsed, expected_ms: truth.elapsed_ms };
    check(
      `${label} the rendered duration == completed_at − started_at (±the printed unit)`,
      parsed !== null && Math.abs(parsed.ms - truth.elapsed_ms) < parsed.tolerance,
      true,
    );
  }
  check(`${label} the TIME line carries the run's own started_at`, (dom.time ?? "").includes(run.started_at ?? " "), true);

  /* ── prose: every quotation verbatim ──────────────────────────────────── */
  const quoteFindings = [];
  for (const s of dom.snippets) {
    const shown = s.text.replace(/\s*\[clipped\]$/, "");
    const bare = shown.endsWith("…") ? shown.slice(0, -1) : shown;
    const hit = run.thread.find(
      (e) => typeof e.content === "string" && e.content.includes(bare) && isProse(e),
    );
    quoteFindings.push({
      shown_len: shown.length,
      clipped: s.clipped,
      verbatim_substring_of_a_real_entry: hit !== undefined,
      entry_ts: hit?.ts ?? null,
      ts_on_screen: s.ts,
    });
  }
  check(
    `${label} every quoted snippet is a verbatim substring of a real prose entry`,
    quoteFindings.filter((q) => !q.verbatim_substring_of_a_real_entry),
    [],
  );
  check(
    `${label} the snippets are the LAST ${DIGEST_SNIPPETS} prose turns, in order`,
    dom.snippets.map((s) => s.text.replace(/\s*\[clipped\]$/, "")),
    truth.snippets.map((s) => s.text),
  );
  check(
    `${label} each snippet's timestamp is its entry's own ts`,
    dom.snippets.map((s) => s.ts),
    truth.snippets.map((s) => s.ts.slice(11, 19)),
  );

  if (truth.outcome !== null) {
    const shown = dom.outcome ?? "";
    const bare = shown.endsWith("…") ? shown.slice(0, -1) : shown;
    check(
      `${label} WHERE IT STANDS is verbatim from the last prose turn`,
      truth.outcome_source_entry.includes(bare) && bare.length > 0,
      true,
    );
    check(`${label} …and it is the exact string the digest rule produces`, shown, truth.outcome);
  }

  check(`${label} the block names its own limits doc`, dom.gapDoc, "docs/plan/artifacts/phase600/digest-gap.md");

  await page.locator("[data-nav-back]").click();
  await page.waitForTimeout(2_000);

  return { run_id: runId, label, rederived: { ...truth, snippets: truth.snippets.map(({ source, ...r }) => r) }, dom, duration: durationReport, quotes: quoteFindings };
}

async function main() {
  const { results, check, note, failed } = makeChecker();

  /* ── discovery: the largest thread in the fleet, at run time ──────────── */
  const fleet = await api("/api/agents");
  let big = null;
  for (const a of fleet.agents ?? []) {
    let run;
    try {
      run = await apiRun(a.id);
    } catch {
      continue;
    }
    if (big === null || run.thread.length > big.entries)
      big = { id: a.id, entries: run.thread.length, status: run.status, role: a.role };
  }
  if (big === null || big.entries < MIN_ENTRIES) {
    console.error(
      `NO-LARGE-SESSION — the largest thread in the fleet is ${big?.entries ?? 0} entries; ` +
        `this protocol needs >=${MIN_ENTRIES}. Not a pass.`,
    );
    process.exit(1);
  }
  console.log(`big fixture: ${big.id} · ${big.entries} entries · ${big.status} · ${big.role}`);

  const payload = await withBrowser(async (ctx) => {
    const injected = await injectTeamRow(ctx, (fleet.agents ?? []).find((a) => a.id === big.id));
    const page = await ctx.newPage();
    await openChat(page);

    const bigReport = await measure(page, big.id, "[big]", check, note);
    check(`[big] the fixture really is >=${MIN_ENTRIES} entries`, bigReport.rederived.entry_count >= MIN_ENTRIES, true);

    /* The roster half, on a worker that is genuinely in this chat's tree. */
    const rosterId = await page.evaluate(() => {
      const all = Array.from(document.querySelectorAll("[data-team-row]"));
      for (let i = 0; i < all.length; i++) {
        if (all[i].getAttribute("data-kind") !== "subagent" || all[i].getAttribute("data-depth") !== "2") continue;
        for (let j = i - 1; j >= 0; j--)
          if (all[j].getAttribute("data-kind") === "worker") return all[j].getAttribute("data-node-id");
      }
      return null;
    });
    let rosterReport = null;
    let crossSurface = null;
    if (rosterId === null) {
      note("[roster] SKIPPED — no worker in this tree owns a sub-agent", true);
    } else {
      rosterReport = await measure(page, rosterId, "[roster]", check, note);
      check("[roster] the roster fixture actually has a sub-agent", rosterReport.rederived.subagent_count >= 1, true);

      /* ── CROSS-SURFACE, recorded as a FINDING and not as a verdict ───────
       * The digest's roster reads roles from `subagents_v2` only. The team
       * panel (`foldSubagents`) and the drilled header (`findSpawnFacts`) both
       * fall back to the spawn call's `input.subagent_type` when the rollup is
       * silent — which it is on almost every run in this database. So the same
       * sub-agent can read "scout" in two places and "unknown" in a third.
       *
       * This is NOT counted as a failure of `digest-honesty`: every claim the
       * digest makes about its own rule is true, and "unknown" is the honest
       * answer for the source it consults. It is a disagreement BETWEEN
       * surfaces, it is app-code to fix, and an evidence round may not change
       * app code. Measured here so the reviewer sees the number, and written up
       * in README.md §FINDINGS. */
      const chatId = await page.evaluate(() =>
        document.querySelector("[data-team-panel]")?.getAttribute("data-chat-id") ?? null,
      );
      const rows = await page.evaluate((parent) => {
        const all = Array.from(document.querySelectorAll("[data-team-row]"));
        const i = all.findIndex((r) => r.getAttribute("data-node-id") === parent);
        const out = [];
        for (let j = i + 1; j < all.length; j++) {
          if (all[j].getAttribute("data-kind") !== "subagent") break;
          out.push({
            id: all[j].getAttribute("data-node-id"),
            role: all[j].getAttribute("data-role"),
          });
        }
        return out;
      }, rosterId);
      crossSurface = {
        parent_run: rosterId,
        team_panel_rows: rows,
        digest_roles: rosterReport.rederived.subagent_roles,
        agrees: rows.every((r) => rosterReport.rederived.subagent_roles.includes(r.role)),
        verdict: rows.every((r) => rosterReport.rederived.subagent_roles.includes(r.role))
          ? "AGREE"
          : "FINDING — the team panel and the digest name the same sub-agent differently",
        why:
          "story-digest.ts reads roles from metadata.subagents_v2 only; agents-shared.ts " +
          "foldSubagents and AgentChatView.findSpawnFacts also read the spawn call's " +
          "input.subagent_type. This run's subagents_v2 is empty, so only the digest says 'unknown'.",
      };
      note("CROSS-SURFACE sub-agent role agreement (finding, not a verdict)", crossSurface);
    }

    return {
      base: BASE,
      api: API,
      chat: CHAT_TEXT,
      fixtures: {
        big: { ...big, navigation: "injected-team-row", injected_node: injected },
        roster: rosterId === null ? null : { id: rosterId, navigation: "real — clicked in the tree" },
      },
      reports: [bigReport, rosterReport].filter(Boolean),
      cross_surface_finding: crossSurface,
    };
  });

  finish("digest-honesty.json", { ...payload, failures: failed(), results }, failed());
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(2);
});
