/**
 * Neighbours — the journeys this round's changes could plausibly have broken.
 *
 * Round 1875 touched the transcript (a second query and a `title` on every comms
 * card), both panels' armed state (two document listeners), the toast copy, the
 * id shortener four places use, and the phone header. So: DoD 1 (frozen
 * durations), DoD 3 (hover cost and typing cost — the transcript now resolves
 * peers, and the panels now listen on `document`), and both themes.
 *
 * Method and thresholds are round 1874's tester's, verbatim where possible, so
 * the numbers are comparable rather than merely present.
 */
const { BASE, open, shot, guardRunControl, say, results, note, fs, path, gotoSurface } =
  require("./lib.cjs");

const durations = (page, sel) =>
  page.evaluate((s) => {
    const rows = [...document.querySelectorAll(s)];
    return rows.map((r) => {
      const t = r.innerText || "";
      const m = t.match(/\b(\d+h\s*\d+m|\d+m\s*\d+s|\d+s|\d+h)\b/);
      return {
        id: r.getAttribute("data-node-id") || r.getAttribute("data-run-id"),
        settled: r.getAttribute("data-settled"),
        dur: m ? m[1] : null,
      };
    });
  }, sel);

(async () => {
  const { browser, page } = await open();
  await guardRunControl(page, []);
  await page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  await gotoSurface(page, "CHAT");
  await page.waitForTimeout(5000);

  /* ── DoD 1: a settled row's duration never moves ───────────────────────── */
  const d0 = await durations(page, "[data-team-row]");
  note(`team rows: ${d0.length}; settled ${d0.filter((x) => x.settled === "true").length}`);

  /* ── DoD 3a: hover, measured against an idle control of the same length ── */
  const team = await page.evaluate(() =>
    [...document.querySelectorAll("[data-team-row]")].slice(0, 16).map((r) => {
      const b = r.getBoundingClientRect();
      return { x: b.x + 70, y: b.y + b.height / 2 };
    }),
  );
  const start = () =>
    page.evaluate(() => {
      window.__l = [];
      window.__o = new PerformanceObserver((l) =>
        l.getEntries().forEach((e) => window.__l.push(Math.round(e.duration))),
      );
      try {
        window.__o.observe({ entryTypes: ["longtask"] });
      } catch {}
    });
  const stop = () =>
    page.evaluate(() => {
      window.__o.disconnect();
      return window.__l;
    });

  const W = 2600;
  const trials = { idle: [], teamHover: [] };
  for (let i = 0; i < 3; i++) {
    await page.mouse.move(760, 500);
    await start();
    await page.waitForTimeout(W);
    trials.idle.push(await stop());
    await start();
    const t = Date.now();
    while (Date.now() - t < W) {
      for (const b of team) {
        await page.mouse.move(b.x, b.y);
        await page.waitForTimeout(40);
        if (Date.now() - t >= W) break;
      }
    }
    trials.teamHover.push(await stop());
  }
  const count = (a) => a.reduce((x, y) => x + y.length, 0);
  const worst = (a) => Math.max(0, ...a.flat());
  note(`idle: ${count(trials.idle)} long tasks (worst ${worst(trials.idle)}ms) over 3×${W}ms`);
  note(`team hover: ${count(trials.teamHover)} (worst ${worst(trials.teamHover)}ms)`);
  say(
    "DoD3 hovering adds no long tasks beyond the idle page",
    count(trials.teamHover) <= count(trials.idle) + 2,
    `idle ${count(trials.idle)} | team ${count(trials.teamHover)} per 3×2.6s`,
  );

  const lat = await page.evaluate(() => {
    const rows = [...document.querySelectorAll("[data-team-row]")].slice(0, 12);
    const out = [];
    for (const r of rows) {
      const b = r.getBoundingClientRect();
      const t0 = performance.now();
      r.dispatchEvent(
        new MouseEvent("mouseover", { bubbles: true, clientX: b.x + 40, clientY: b.y + 5 }),
      );
      out.push(Math.round((performance.now() - t0) * 100) / 100);
      r.dispatchEvent(new MouseEvent("mouseout", { bubbles: true }));
    }
    return out;
  });
  const avg = lat.reduce((a, b) => a + b, 0) / lat.length;
  say(
    "DoD3 a hover event is handled in under 8ms",
    avg < 8,
    `avg ${avg.toFixed(2)}ms, max ${Math.max(...lat)}ms over ${lat.length} rows`,
  );

  /* ── DoD 3b: typing, with the transcript's new query mounted ─────────────
     Round 1874's method exactly: real keystrokes through CDP, measured per
     key, threshold < 20 ms/key. (Its headline 2.77 ms came from the same
     harness on the same box, so the two numbers are comparable.) */
  const composer = await page.evaluate(() => {
    const t = document.querySelector("textarea");
    if (!t) return null;
    const r = t.getBoundingClientRect();
    return { x: r.x + 60, y: r.y + r.height / 2 };
  });
  let typed = null;
  if (composer) {
    await page.mouse.click(composer.x, composer.y);
    await page.evaluate(() => {
      window.__k = [];
    });
    const text = "the quick brown fox jumps over the lazy dog while the operator watches";
    for (const ch of text) {
      const k0 = Date.now();
      await page.keyboard.type(ch);
      await page.evaluate((d) => window.__k.push(d), Date.now() - k0);
    }
    const ks = await page.evaluate(() => window.__k);
    const sorted = ks.slice().sort((a, b) => a - b);
    typed = {
      n: ks.length,
      avg: Math.round((ks.reduce((a, b) => a + b, 0) / ks.length) * 100) / 100,
      p95: sorted[Math.floor(sorted.length * 0.95)],
    };
    await page.keyboard.down("Control");
    await page.keyboard.press("KeyA");
    await page.keyboard.up("Control");
    await page.keyboard.press("Backspace");
    const left = await page.evaluate(() => document.querySelector("textarea")?.value ?? "");
    say("Composer the draft can be cleared (nothing left behind)", left.trim() === "", JSON.stringify(left.slice(0, 40)));
  }
  note(`typing: ${JSON.stringify(typed)}`);
  say(
    "Composer typing stays under 20 ms/key (round 1874's own threshold)",
    typed !== null && typed.avg < 20,
    `${typed?.avg} ms/key avg, p95 ${typed?.p95} ms over ${typed?.n} keys`,
  );

  /* ── back to DoD 1, now that ~40s have passed ──────────────────────────── */
  const d1 = await durations(page, "[data-team-row]");
  const byId = new Map(d1.map((x) => [x.id, x]));
  const pairs = d0.filter((x) => x.settled === "true" && x.dur && byId.has(x.id));
  const moved = pairs.filter((x) => byId.get(x.id).dur !== x.dur);
  say(
    "DoD1 every settled team duration is byte-identical after the run",
    moved.length === 0,
    `${pairs.length} settled rows compared; moved ${moved.length}`,
  );

  /* ── DoD 2 still holds: every row classified, with a model ─────────────── */
  const kinds = await page.evaluate(() =>
    [...document.querySelectorAll("[data-team-row]")].map((r) => ({
      kind: r.getAttribute("data-kind"),
      role: r.getAttribute("data-role"),
      /* The LONGEST title in the row — the lineage tooltip. A shorter one
         ("total run time" on the duration cell) is a different tooltip and
         must not be mistaken for it. */
      titled: Math.max(
        (r.getAttribute("title") || "").length,
        ...[...r.querySelectorAll("[title]")].map((e) => (e.getAttribute("title") || "").length),
        0,
      ),
    })),
  );
  say(
    "DoD2 every row is classified and carries a lineage tooltip",
    kinds.length > 0 && kinds.every((k) => k.kind && k.titled > 40),
    `${kinds.length} rows, ${kinds.filter((k) => k.titled > 40).length} with a tooltip`,
  );

  await shot(page, "09-neighbours-dark");

  /* ── both themes ───────────────────────────────────────────────────────── */
  const themed = await page.evaluate(() => {
    const btn = [...document.querySelectorAll("button")].find(
      (b) => /theme|light|dark/i.test(b.getAttribute("aria-label") || b.getAttribute("title") || ""),
    );
    if (btn) btn.click();
    return document.documentElement.getAttribute("data-theme");
  });
  await page.waitForTimeout(1200);
  const light = await page.evaluate(() => ({
    theme: document.documentElement.getAttribute("data-theme"),
    bg: getComputedStyle(document.body).backgroundColor,
    cards: document.querySelectorAll("[data-comms-direction]").length,
    cardInk: (() => {
      const c = document.querySelector("[data-comms-direction] [data-comms-toggle] span");
      return c ? getComputedStyle(c).color : null;
    })(),
  }));
  note(`theme after toggle: ${JSON.stringify(light)} (was ${themed})`);
  say(
    "Both themes render the comms cards",
    light.cards > 0 && light.cardInk !== null,
    `theme=${light.theme} bg=${light.bg} cards=${light.cards} ink=${light.cardInk}`,
  );
  await shot(page, "10-neighbours-light");

  fs.writeFileSync(
    path.join(__dirname, "n1.json"),
    JSON.stringify({ trials, lat, typed, moved, kinds: kinds.length, light, results }, null, 1),
  );
  await browser.close();
})();
