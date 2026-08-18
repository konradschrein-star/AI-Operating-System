/**
 * FINDING 4 — "Every sub-agent row's tooltip shows the same id … all 7 rows'
 * tooltips end `· id toolu_01 ·`."
 * FINDING 5 — "The phone's menu button is smaller than everything it opens:
 * 34×34 while all 18 destinations inside the sheet are a correct 44 px."
 */
const { BASE, open, shot, guardRunControl, say, results, note, fs, path, gotoSurface } =
  require("./lib.cjs");

(async () => {
  /* ── FINDING 4: two sub-agents, told apart ─────────────────────────────── */
  const { browser, page } = await open();
  await guardRunControl(page, []);
  await page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  await gotoSurface(page, "CHAT");
  await page.waitForTimeout(4000);

  const subs = await page.evaluate(() =>
    [...document.querySelectorAll('[data-team-row][data-kind="subagent"]')].map((r) => {
      const titled = r.querySelector("[title]");
      const title = r.getAttribute("title") ?? titled?.getAttribute("title") ?? "";
      return {
        id: r.getAttribute("data-node-id"),
        title,
        idSegment: (title.match(/· id ([^\s·]+)/) || [])[1] ?? null,
      };
    }),
  );
  const segments = subs.map((s) => s.idSegment);
  const unique = new Set(segments.filter(Boolean));
  console.log(JSON.stringify(subs.slice(0, 8), null, 1));
  say(
    "F4 every sub-agent row's tooltip carries an id segment",
    subs.length > 1 && segments.every((s) => s !== null),
    `${subs.length} sub-agent rows, ${segments.filter(Boolean).length} with an id in the tooltip`,
  );
  say(
    "F4 no tooltip says `toolu_01` — the constant the tester read on all 7",
    segments.every((s) => s !== "toolu_01"),
    JSON.stringify(segments.slice(0, 8)),
  );
  say(
    "F4 the ids are DISTINCT: two sub-agents can be told apart",
    unique.size === segments.filter(Boolean).length,
    `${unique.size} distinct segments across ${segments.length} rows`,
  );
  say(
    "F4 each segment is the discriminating part of its own id",
    subs.every((s) => s.idSegment === null || (s.id || "").includes(s.idSegment)),
    JSON.stringify(subs.slice(0, 3).map((s) => ({ id: s.id, seg: s.idSegment }))),
  );

  /* Hover one, so the screenshot shows the real native tooltip path. */
  if (subs.length > 0) {
    await page.evaluate((id) => {
      document
        .querySelector(`[data-team-row][data-node-id="${id}"]`)
        ?.scrollIntoView({ block: "center" });
    }, subs[0].id);
    await page.waitForTimeout(400);
    await shot(page, "06-f4-subagent-rows");
  }
  await browser.close();

  /* ── FINDING 5: the phone's menu button ────────────────────────────────── */
  const phone = await open({ mobile: true, viewport: { width: 390, height: 844 } });
  await guardRunControl(phone.page, []);
  await phone.page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
  await phone.page.waitForTimeout(4500);

  const btn = await phone.page.evaluate(() => {
    const b = document.querySelector("[data-nav-menu]");
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100, label: b.getAttribute("aria-label") };
  });
  note(`menu button ${JSON.stringify(btn)}`);
  say(
    "F5 the menu button is a 44px thumb target",
    btn !== null && btn.w >= 44 && btn.h >= 44,
    `${btn?.w}×${btn?.h} (was 34×34)`,
  );
  await shot(phone.page, "07-f5-phone-landing");

  await phone.page.click("[data-nav-menu]");
  await phone.page.waitForTimeout(900);
  const items = await phone.page.evaluate(() => {
    const els = [...document.querySelectorAll("[data-nav-menu-item]")];
    return els.map((e) => {
      const r = e.getBoundingClientRect();
      return { key: e.getAttribute("data-nav-menu-item"), h: Math.round(r.height * 100) / 100 };
    });
  });
  const bar = await phone.page.evaluate(() => {
    const b = document.querySelector("[data-nav-menu]");
    const header = b?.parentElement;
    return {
      barH: header ? Math.round(header.getBoundingClientRect().height * 100) / 100 : null,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  say(
    "F5 the button is no smaller than the destinations it opens",
    btn !== null && items.length > 0 && items.every((i) => btn.h >= i.h - 0.01),
    `button ${btn?.h}px vs ${items.length} items at ${[...new Set(items.map((i) => i.h))].join("/")}px`,
  );
  say(
    "F5 …and the 46px bar did not grow or overflow to fit it",
    bar.barH !== null && bar.barH <= 46.5 && bar.overflow === false,
    `bar ${bar.barH}px, horizontal overflow ${bar.overflow}`,
  );
  say(
    "F5 all 18 destinations are still there",
    items.length === 18,
    `${items.length} destinations in the sheet`,
  );
  await shot(phone.page, "08-f5-phone-menu-open");

  fs.writeFileSync(
    path.join(__dirname, "f4-f5.json"),
    JSON.stringify({ subs, segments, btn, items, bar, results }, null, 1),
  );
  await phone.browser.close();
})();
