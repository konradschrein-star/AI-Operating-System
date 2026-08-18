/**
 * FINDING 1, the counterfactual — how many cards does the lookup actually
 * rescue?
 *
 * "0 unknown" is only evidence if the alternative is worse. So this run is the
 * same page with `GET /agents/peers` REFUSED (500 at the route boundary, which
 * is what a client with no such endpoint sees), and it counts the cards that
 * then cannot name their sender. The difference between the two numbers is the
 * finding, measured.
 */
const { BASE, open, shot, guardRunControl, say, results, note, fs, path, gotoSurface } =
  require("./lib.cjs");

const census = (page) =>
  page.evaluate(() => {
    const cs = [...document.querySelectorAll("[data-comms-direction]")];
    const bad = cs.filter((c) => /unknown role/i.test(c.innerText || ""));
    return {
      total: cs.length,
      bad: bad.length,
      badPeers: bad.slice(0, 6).map((c) => c.getAttribute("data-comms-peer")?.slice(0, 8)),
      project:
        document
          .querySelector('[data-project-choice][aria-pressed="true"]')
          ?.textContent?.trim()
          .slice(0, 40) ?? null,
    };
  });

(async () => {
  const { browser, page } = await open();
  await guardRunControl(page, []);
  let refused = 0;
  await page.route("**/api/proxy/agents/peers**", async (route) => {
    refused += 1;
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "peers lookup refused by the harness" }),
    });
  });

  await page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  await gotoSurface(page, "CHAT");
  await page.waitForTimeout(6000);

  const withPanelOnOwnProject = await census(page);
  note(`lookup refused ${refused}×; ${JSON.stringify(withPanelOnOwnProject)}`);

  /* Same switch as f1: the tree loses every operator-visibility peer. */
  const other = await page.evaluate(
    () =>
      [...document.querySelectorAll("[data-project-choice]")].find(
        (c) => c.getAttribute("aria-pressed") !== "true",
      )?.getAttribute("data-project-choice") ?? null,
  );
  let switched = null;
  if (other) {
    await page.click(`[data-project-choice="${other}"]`);
    await page.waitForTimeout(6000);
    switched = await census(page);
    note(`with the tree on the other project: ${JSON.stringify(switched)}`);
  }

  say(
    "F1 the transcript still renders when the lookup fails — no crash, no blank",
    withPanelOnOwnProject.total > 0 && (switched === null || switched.total > 0),
    `${withPanelOnOwnProject.total} cards with the lookup refused ${refused}×`,
  );
  say(
    "F1 …and the cards it would have named are exactly the ones that go unnamed",
    switched !== null && switched.bad > 0,
    `${switched?.bad}/${switched?.total} unnamed without the lookup (f1.json records 0/${switched?.total} with it) — peers ${JSON.stringify(switched?.badPeers)}`,
  );
  await shot(page, "01c-f1-counterfactual-no-lookup");

  fs.writeFileSync(
    path.join(__dirname, "f1b.json"),
    JSON.stringify({ refused, withPanelOnOwnProject, switched, results }, null, 1),
  );
  await browser.close();
})();
