/**
 * FINDING 1 — "28 of 128 comms cards don't say who spoke."
 *
 * Reads the operator chat exactly as round 1874's `f6b-unknown.cjs` did: every
 * `[data-comms-direction]` card, counted by whether its text contains the words
 * "unknown role", split by age, plus the `title` attribute ON THE CARD (the
 * element the tester read, which used to be empty).
 */
const { BASE, open, shot, guardRunControl, say, results, note, fs, path, gotoSurface } =
  require("./lib.cjs");

(async () => {
  const { browser, page } = await open();
  await guardRunControl(page, []);

  /* Every /agents/peers request the page makes, so "one lookup, not a poll" is
     a measurement rather than a claim. */
  const peerCalls = [];
  page.on("request", (r) => {
    if (r.url().includes("/agents/peers")) peerCalls.push({ url: r.url(), t: Date.now() });
  });

  await page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  await gotoSurface(page, "CHAT");
  await page.waitForTimeout(6000);

  const detail = await page.evaluate(() => {
    const cs = [...document.querySelectorAll("[data-comms-direction]")];
    const bad = cs.filter((c) => /unknown role/i.test(c.innerText || ""));
    const good = cs.filter((c) => !/unknown role/i.test(c.innerText || ""));
    const ageOf = (c) => ((c.innerText || "").match(/\b(\d+[dhm])\b/) || [])[1] || null;
    const tally = (list) =>
      list.map(ageOf).reduce((a, x) => {
        a[x] = (a[x] || 0) + 1;
        return a;
      }, {});
    const sample = (c) => ({
      text: (c.innerText || "").replace(/\n/g, " | ").slice(0, 120),
      peer: c.getAttribute("data-comms-peer"),
      role: c.getAttribute("data-comms-role"),
      title: (c.getAttribute("title") || "").slice(0, 180),
    });
    return {
      total: cs.length,
      bad: bad.length,
      badAges: tally(bad),
      goodAges: tally(good),
      badSample: bad.slice(0, 4).map(sample),
      /* The cards the tester quoted, by peer id — the three he printed. */
      quoted: ["c8bc5ffa", "4e842cc8", "e69ea9a8"].map((p) => {
        const c = cs.find((x) => (x.getAttribute("data-comms-peer") || "").startsWith(p));
        return c ? { peer: p, ...sample(c) } : { peer: p, missing: true };
      }),
      withTitle: cs.filter((c) => (c.getAttribute("title") || "").length > 10).length,
      withRoleAttr: cs.filter((c) => (c.getAttribute("data-comms-role") || "") !== "").length,
    };
  });

  console.log(JSON.stringify(detail, null, 1));
  say(
    "F1 every comms card names its sender",
    detail.bad === 0,
    `${detail.bad}/${detail.total} cards read "unknown role"; ages ${JSON.stringify(detail.badAges)}`,
  );
  say(
    "F1 the three cards the tester quoted are named",
    detail.quoted.every((q) => !q.missing && !/unknown role/i.test(q.text)),
    JSON.stringify(detail.quoted.map((q) => q.text.slice(0, 60))),
  );
  say(
    "F1 the card itself carries a tooltip (the attribute he read)",
    detail.withTitle === detail.total,
    `${detail.withTitle}/${detail.total} cards have a title on the card element`,
  );
  say(
    "F1 …naming the role, not the word unknown",
    detail.quoted.every((q) => !q.missing && q.title.length > 20 && !/unknown/i.test(q.title)),
    JSON.stringify(detail.quoted[0] || null).slice(0, 260),
  );
  say(
    "F1 data-comms-role is set on every card",
    detail.withRoleAttr === detail.total,
    `${detail.withRoleAttr}/${detail.total}`,
  );

  /* One lookup, not a poll: wait through two team-poll intervals and count. */
  const before = peerCalls.length;
  await page.waitForTimeout(14000);
  say(
    "F1 the lookup does not become a poll",
    peerCalls.length === before,
    `${before} request(s) on open, ${peerCalls.length - before} more in the next 14s`,
  );
  note(`peers requests: ${JSON.stringify(peerCalls.map((c) => c.url.split("?")[1]?.slice(0, 60)))}`);

  await page.evaluate(() => {
    const c = document.querySelector("[data-comms-direction]");
    c?.scrollIntoView({ block: "center" });
  });
  await page.waitForTimeout(600);
  await shot(page, "01-f1-comms-named");

  /* ── The hard case: the team tree pointed at the OTHER project ──────────
   *
   * The tree is one project's team, so which project the panel is showing
   * decides which peers it can name — and that is exactly why the tester's 28
   * were nameless while mine were not, on the same data. Switch the panel to
   * the other project this chat started and the tree loses every
   * operator-visibility peer. If the cards stay named, the naming is coming
   * from the lookup and from nowhere else. */
  const chips = await page.evaluate(() =>
    [...document.querySelectorAll("[data-project-choice]")].map((c) => ({
      id: c.getAttribute("data-project-choice"),
      pressed: c.getAttribute("aria-pressed"),
      text: (c.innerText || "").trim().slice(0, 40),
    })),
  );
  note(`project chips: ${JSON.stringify(chips)}`);
  let switched = null;
  const other = chips.find((c) => c.pressed !== "true");
  if (other) {
    await page.click(`[data-project-choice="${other.id}"]`);
    await page.waitForTimeout(6000);
    switched = await page.evaluate(() => {
      const cs = [...document.querySelectorAll("[data-comms-direction]")];
      return {
        project: document.querySelector('[data-project-choice][aria-pressed="true"]')?.textContent?.trim().slice(0, 40) ?? null,
        rows: document.querySelectorAll("[data-team-row]").length,
        total: cs.length,
        bad: cs.filter((c) => /unknown role/i.test(c.innerText || "")).length,
      };
    });
    note(`after switching to the other project: ${JSON.stringify(switched)}`);
    say(
      "F1 the cards stay named when the tree can no longer name them",
      switched !== null && switched.bad === 0 && switched.total > 0,
      `${switched?.bad}/${switched?.total} unknown with the panel on "${switched?.project}" (${switched?.rows} team rows)`,
    );
    await shot(page, "01b-f1-named-with-other-project");
  } else {
    note("only one project chip — the hard case is not reachable in this chat");
  }

  fs.writeFileSync(
    path.join(__dirname, "f1.json"),
    JSON.stringify({ detail, peerCalls, chips, switched, results }, null, 1),
  );
  await browser.close();
})();
