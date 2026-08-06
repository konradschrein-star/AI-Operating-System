/**
 * orientation-live.cjs — U22, 14 §600: "orientation strip on a LIVE worker
 * (values change with `current_activity`)".
 *
 * The strip's `currently:` line is sampled TWICE, >=20s apart, on a worker that
 * is running right now, and each reading is matched against
 * `metadata.current_activity` as the API reported it at that moment.
 *
 * NO RUN ID IS HARDCODED. The target is discovered from `GET /api/agents` when
 * the script starts, exactly the way `phase500/team-frozen.cjs` does it, and an
 * idle fleet is refused with a named error (`NO-LIVE-RUN`, exit 1) rather than
 * reported as a pass. The script starts nothing, resumes nothing and writes
 * nothing.
 *
 * TWO THINGS ARE DELIBERATE AND BOTH ARE VISIBLE IN THE JSON:
 *
 *  1. `navigation: "injected-team-row"`. No chat in this database has a live
 *     worker in its team (lib-604.cjs explains why in full), so the running run
 *     is spliced into the team RESPONSE to make it clickable. The node carries
 *     the real id/status/role/model from `/api/agents` and `task: null` — which
 *     is why the strip's plan half degrades to "no project task on this node",
 *     recorded below as `degraded`. Everything asserted here comes from the
 *     un-intercepted `/api/chat/:runId` and `/api/agents`.
 *
 *  2. THE EXPECTED LINE IS RE-DERIVED HERE, not imported. `activityLine` and
 *     `clipLine` are 20 lines of taxonomy; re-stating them in the protocol is
 *     what makes this a test of the strip rather than a test of itself. If the
 *     two ever disagree, one of them is wrong and the diff is in the JSON.
 *
 * The strip refetches on the detail query's own cadence (3s while the open chat
 * has no live stream), so a DOM reading can be up to one poll behind the API.
 * Rather than sleep and hope, the API is sampled continuously and each DOM
 * reading is matched against the sample whose `ts` the DOM itself reports —
 * an exact identity, not a fuzzy time comparison. The matched sample's age is
 * recorded so a reviewer can see how far behind the strip actually was.
 *
 * Run: see README.md §2.
 */

const { finish, api, apiRun, makeChecker, openChat, injectTeamRow, withBrowser, API, BASE, CHAT_TEXT } =
  require("./lib-604.cjs");

const GAP_MS = 25_000; // the brief's ">=20s apart", with slack
const SAMPLE_MS = 1_500;
const ACTIVITY_MAX = 130; // OrientationStrip.tsx:89

/* ── The taxonomy, re-derived (OrientationStrip.tsx:161-192) ─────────────── */

function parseActivity(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const str = (k) => (typeof value[k] === "string" && value[k].trim() !== "" ? value[k] : null);
  const a = { kind: str("kind"), tool: str("tool"), text: str("text"), ts: str("ts") };
  if (a.kind === null && a.tool === null && a.text === null) return null;
  return a;
}

function activityLine(a) {
  switch (a.kind) {
    case "assistant_text":
      return { verb: "writing", detail: a.text, known: true };
    case "thinking":
      return { verb: "thinking", detail: a.text, known: true };
    case "tool_call":
      return {
        verb: a.tool === null ? "calling a tool" : `calling ${a.tool}`,
        detail: a.text !== null && a.text === a.tool ? null : a.text,
        known: true,
      };
    case "tool_result":
      return {
        verb: a.tool === null ? "a tool returned" : `${a.tool} returned`,
        detail: a.text,
        known: true,
      };
    default:
      return { verb: a.kind ?? "unrecorded", detail: a.text, known: false };
  }
}

function clipLine(text, max) {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max).trimEnd()}…`;
}

/** What the strip's second line should read for a given activity. */
function expectedLine(activity) {
  if (activity === null) return null;
  const line = activityLine(activity);
  const detail = line.detail === null ? null : clipLine(line.detail, ACTIVITY_MAX);
  return detail === null ? line.verb : `${line.verb} ${detail}`;
}

/* ── DOM ──────────────────────────────────────────────────────────────────── */

const readStrip = () => {
  const strip = document.querySelector("[data-orientation-strip]");
  if (strip === null) return null;
  const lines = Array.from(strip.children);
  const second = lines[1];
  const verb = (second?.firstElementChild?.textContent ?? "").trim();
  const act = second?.querySelector("[data-orientation-activity]") ?? null;
  const title = act?.getAttribute("title") ?? "";
  const tsLine = title.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? null;
  return {
    verb,
    kind: act?.getAttribute("data-orientation-activity") ?? null,
    line:
      act === null
        ? (second?.querySelector("[data-orientation-missing]")?.textContent ?? null)
        : Array.from(act.children)
            .map((c) => (c.textContent ?? "").trim())
            .filter((t) => t !== "")
            .join(" "),
    ts: tsLine !== null && /^\d{4}-\d{2}-\d{2}T/.test(tsLine) ? tsLine : null,
    degraded: strip.getAttribute("data-orientation-degraded"),
    role: document.querySelector("[data-agent-role]")?.textContent ?? null,
    model: document.querySelector("[data-agent-model]")?.textContent ?? null,
  };
};

async function main() {
  const { results, check, note, failed } = makeChecker();

  /* ── discovery, at run time ───────────────────────────────────────────── */
  const fleet = await api("/api/agents");
  const live = (fleet.agents ?? []).filter(
    (a) => (a.status === "running" || a.status === "queued") && a.kind !== "subagent",
  );
  if (live.length === 0) {
    console.error(
      "NO-LIVE-RUN — GET /api/agents reports no running or queued run right now. " +
        "This protocol needs a worker that is actually working; a missing half is never reported as a pass.",
    );
    process.exit(1);
  }
  const target = live[0];
  console.log(
    `target: ${target.id} · ${target.status} · ${target.role} · ${target.model} · ${(target.title ?? "").slice(0, 60)}`,
  );

  const samples = [];
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const now = await api("/api/agents");
        const row = (now.agents ?? []).find((a) => a.id === target.id);
        samples.push({
          at: Date.now(),
          status: row?.status ?? null,
          activity: row?.current_activity ?? null,
        });
      } catch (e) {
        samples.push({ at: Date.now(), error: String(e) });
      }
      await new Promise((r) => setTimeout(r, SAMPLE_MS));
    }
  })();

  const payload = await withBrowser(async (ctx) => {
    const injected = await injectTeamRow(ctx, target);
    const page = await ctx.newPage();
    await openChat(page);

    const present = await page.locator(`[data-team-row][data-node-id="${target.id}"]`).count();
    check("the live worker is on screen as a team row", present, 1);
    await page.locator(`[data-team-row][data-node-id="${target.id}"]`).click();
    await page.waitForSelector("[data-orientation-strip]", { timeout: 30_000 });
    await page.waitForTimeout(4_000);

    const takeSample = async (n) => {
      const domAt = Date.now();
      const dom = await page.evaluate(readStrip);
      const detail = await apiRun(target.id);
      const detailActivity = parseActivity((detail.metadata ?? {}).current_activity);
      return { n, domAt, dom, detail: { status: detail.status, activity: detailActivity } };
    };

    const s1 = await takeSample(1);
    await new Promise((r) => setTimeout(r, GAP_MS));
    const s2 = await takeSample(2);

    check("the two samples are >=20s apart", s2.domAt - s1.domAt >= 20_000, true);
    note("actual gap (ms)", s2.domAt - s1.domAt);

    const verdicts = [];
    for (const s of [s1, s2]) {
      /* The sample the DOM itself names, by activity timestamp. */
      const matched = samples
        .filter((x) => x.activity && x.activity.ts === s.dom.ts)
        .sort((a, b) => a.at - b.at)[0] ?? null;
      const fromMatched = matched === null ? null : expectedLine(parseActivity(matched.activity));
      const fromDetail = expectedLine(s.detail.activity);

      /* Staleness, stated as a number rather than assumed away. The strip
       * refetches on the detail query's 3s interval, so the newest thing it can
       * possibly show at time T is what the API reported at T; one poll behind
       * is correct behaviour and anything older is not. `newest` is the last
       * API sample taken at or before the DOM read. */
      const newest = samples.filter((x) => x.activity && x.at <= s.domAt).sort((a, b) => b.at - a.at)[0] ?? null;
      const showsNewest = newest !== null && newest.activity.ts === s.dom.ts;
      const withinOnePoll =
        showsNewest ||
        samples.some(
          (x) => x.activity && x.activity.ts === s.dom.ts && s.domAt - x.at <= 5_000,
        ) ||
        samples.filter((x) => x.activity && x.at <= s.domAt && s.domAt - x.at <= 5_000)
          .every((x) => x.activity.ts === s.dom.ts);

      check(
        `S${s.n} the strip shows an activity at all (not "not recorded")`,
        s.dom.kind !== null,
        true,
      );
      check(
        `S${s.n} the verb matches the run's liveness at that moment`,
        s.dom.verb,
        s.detail.status === "running" || s.detail.status === "queued" ? "currently:" : "ended:",
      );
      check(
        `S${s.n} the reading is an activity the API actually reported (matched by ts)`,
        matched !== null,
        true,
      );
      check(`S${s.n} the rendered line == that activity, re-derived here`, s.dom.line, fromMatched);
      check(
        `S${s.n} the activity kind on screen == the API's kind`,
        s.dom.kind,
        matched?.activity?.kind ?? null,
      );
      check(
        `S${s.n} the strip is NOT stale — the newest activity the API had, or one 3s poll behind`,
        withinOnePoll,
        true,
      );
      verdicts.push({
        n: s.n,
        dom: s.dom,
        matched_api_sample: matched,
        /* How long this activity had ALREADY been the current one when the DOM
         * was read — the age of the activity, not the strip's lag. A run that
         * spends 20s inside one Bash call reports 20s here and is not stale. */
        activity_age_at_read_ms: matched === null ? null : s.domAt - matched.at,
        shows_the_newest_api_activity: showsNewest,
        newest_api_activity_at_read: newest?.activity ?? null,
        expected_from_matched: fromMatched,
        api_detail_at_dom_read: { ...s.detail, expected_line: fromDetail },
      });
    }

    const changed = s1.dom.line !== s2.dom.line || s1.dom.ts !== s2.dom.ts;
    note("the reading moved between the two samples", changed);
    note("degraded (the injected node carries no task — see the header)", s1.dom.degraded);

    return {
      base: BASE,
      api: API,
      chat: CHAT_TEXT,
      navigation: "injected-team-row",
      injected_node: injected,
      target: {
        id: target.id,
        role: target.role,
        model: target.model,
        title: target.title,
        status_at_discovery: target.status,
      },
      gap_ms: s2.domAt - s1.domAt,
      reading_changed: changed,
      samples: verdicts,
      api_sample_count: samples.length,
      api_samples: samples,
    };
  });

  sampling = false;
  await sampler;
  finish("orientation-live.json", { ...payload, failures: failed(), results }, failed());
}

main().catch((e) => {
  console.error(`FAIL: ${e.message}`);
  process.exit(2);
});
