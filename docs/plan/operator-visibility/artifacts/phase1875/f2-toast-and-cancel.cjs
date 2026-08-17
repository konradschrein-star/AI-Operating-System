/**
 * FINDINGS 2 and 3 — the toast that disagreed with the tray, and the armed ✕
 * that could not be called off.
 *
 * The cascade is STUBBED with the exact shape of the tester's report: the id he
 * clicked plus 179 ids that belong to no row in this tree, so the server's
 * number is 180 and the panel's is whatever it actually loses. Nothing is
 * hidden in the real table — see lib.cjs.
 */
const {
  BASE,
  open,
  shot,
  guardRunControl,
  stubDismissalWrites,
  say,
  results,
  note,
  fs,
  path,
  gotoSurface,
} = require("./lib.cjs");

const readX = (page, id) =>
  page.evaluate((nid) => {
    const row = document.querySelector(`[data-team-row][data-node-id="${nid}"]`);
    const x = row?.querySelector("[data-team-x]");
    const strip = document.querySelector("[data-team-confirm-strip]");
    return {
      confirm: x?.getAttribute("data-confirm") ?? null,
      xText: (x?.innerText || "").trim(),
      strip: (strip?.innerText || "").trim(),
      rows: document.querySelectorAll("[data-team-row]").length,
    };
  }, id);

const clickX = async (page, id) => {
  const box = await page.evaluate((nid) => {
    const row = document.querySelector(`[data-team-row][data-node-id="${nid}"]`);
    const x = row?.querySelector("[data-team-x]");
    if (!x) return null;
    const r = x.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, id);
  if (!box) throw new Error(`no ✕ on ${id}`);
  await page.mouse.click(box.x, box.y);
};

(async () => {
  const { browser, page } = await open();
  const dismissLog = [];
  await guardRunControl(page, []);
  /* 180 ids: the clicked node, every node this tree shows, and enough
     invented-elsewhere ids to reach the tester's number. */
  /* `alsoHide` lets the second scenario add REAL row ids to the cascade, so the
     panel loses 21 rows to a 180-id gesture — the tester's exact arithmetic. */
  let alsoHide = [];
  await stubDismissalWrites(page, dismissLog, (body) => {
    const id = body.id;
    const rest = [id, ...alsoHide];
    const extra = Array.from({ length: 180 - rest.length }, (_, i) =>
      `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
    );
    return [...rest, ...extra];
  });

  await page.goto(`${BASE}/desktop`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  await gotoSurface(page, "CHAT");
  await page.waitForTimeout(4000);

  const rows = await page.evaluate(() =>
    [...document.querySelectorAll("[data-team-row]")].map((r) => ({
      id: r.getAttribute("data-node-id"),
      kind: r.getAttribute("data-kind"),
      settled: r.getAttribute("data-settled"),
      hides: r.querySelector("[data-team-x]")?.getAttribute("data-x-hides") ?? null,
      confirms: r.querySelector("[data-team-x]")?.getAttribute("data-x-confirms") ?? null,
      x: !!r.querySelector("[data-team-x]"),
    })),
  );
  const target = rows.find((r) => r.x && r.confirms === "true");
  if (!target) throw new Error("no confirming ✕ in this tree");
  note(`target row ${target.id} (${target.kind}) hides=${target.hides} rows=${rows.length}`);

  /* ── FINDING 3a: Escape disarms ─────────────────────────────────────── */
  await clickX(page, target.id);
  await page.waitForTimeout(300);
  const armed = await readX(page, target.id);
  say("F3 one click arms (unchanged)", armed.confirm === "armed", `data-confirm=${armed.confirm}`);
  say(
    "F3 the strip says how to cancel",
    /esc or click away cancels/.test(armed.strip),
    armed.strip.slice(0, 200),
  );
  await shot(page, "02-f3-armed-with-cancel-hint");

  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  const afterEsc = await readX(page, target.id);
  say(
    "F3 Escape disarms it — the tester pressed this and nothing happened",
    afterEsc.confirm === "idle",
    `data-confirm=${afterEsc.confirm} after Escape, strip="${afterEsc.strip}"`,
  );
  say("F3 …and hides nothing", afterEsc.rows === armed.rows, `${armed.rows} → ${afterEsc.rows} rows`);

  /* ── FINDING 3b: a click anywhere else disarms ──────────────────────── */
  await clickX(page, target.id);
  await page.waitForTimeout(300);
  const armed2 = await readX(page, target.id);
  say("F3 armed again", armed2.confirm === "armed", `data-confirm=${armed2.confirm}`);
  await page.mouse.click(700, 500); // the transcript, four inches away
  await page.waitForTimeout(250);
  const afterClick = await readX(page, target.id);
  say(
    "F3 clicking in the transcript disarms it",
    afterClick.confirm === "idle",
    `data-confirm=${afterClick.confirm}`,
  );
  say(
    "F3 …and still hides nothing",
    afterClick.rows === armed2.rows && dismissLog.length === 0,
    `${afterClick.rows} rows, ${dismissLog.length} dismissal writes so far`,
  );
  await shot(page, "03-f3-disarmed-by-click");

  /* ── FINDING 2: the toast and the tray, side by side ────────────────── */
  await clickX(page, target.id);
  await page.waitForTimeout(700); // past MIN_CONFIRM_MS, inside ARM_WINDOW_MS
  await clickX(page, target.id);
  await page.waitForTimeout(1200);

  const after = await page.evaluate(() => {
    const toast = [...document.querySelectorAll("div")]
      .map((d) => (d.innerText || "").trim())
      .filter((t) => /hidden/.test(t) && t.length < 300)
      .sort((a, b) => a.length - b.length)[0];
    const tray = [...document.querySelectorAll("button")]
      .map((b) => (b.innerText || "").trim())
      .find((t) => /dismissed · (show|hide)/.test(t));
    const trayTitle =
      [...document.querySelectorAll("button")]
        .find((b) => /dismissed · (show|hide)/.test(b.innerText || ""))
        ?.getAttribute("title") ?? null;
    return {
      toast: toast ?? null,
      tray: tray ?? null,
      trayTitle,
      rows: document.querySelectorAll("[data-team-row]").length,
    };
  });
  const serverCount = dismissLog.filter((d) => d.kind === "dismiss").at(-1)?.count ?? 0;
  const trayNum = Number((after.tray || "").match(/^(\d+)/)?.[1] ?? NaN);
  const toastLocal = Number((after.toast || "").match(/^(\d+) rows? hidden here/)?.[1] ?? NaN);
  const toastTotal = Number((after.toast || "").match(/· (\d+) in total/)?.[1] ?? NaN);

  note(`server cascade: ${serverCount} ids`);
  note(`toast: ${JSON.stringify(after.toast)}`);
  note(`tray:  ${JSON.stringify(after.tray)}`);
  say(
    "F2 the toast leads with the number the tray shows",
    Number.isFinite(trayNum) && toastLocal === trayNum,
    `toast says "${toastLocal} rows hidden here", tray says "${trayNum} dismissed"`,
  );
  say(
    "F2 …and still names the fleet-wide total the undo restores",
    toastTotal === serverCount && /undo restores all/.test(after.toast || ""),
    `${toastTotal} in total vs ${serverCount} ids returned by the server`,
  );
  say(
    "F2 the tray's tooltip explains which number it is",
    /rows THIS panel is withholding/.test(after.trayTitle || ""),
    (after.trayTitle || "").slice(-160),
  );
  await shot(page, "04-f2-toast-vs-tray");

  /* Put it back — the stub's own store, but the gesture is the real one. */
  const undo = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find(
      (x) => (x.innerText || "").trim() === "undo",
    );
    if (!b) return false;
    b.click();
    return true;
  });
  await page.waitForTimeout(1500);
  const restored = dismissLog.filter((d) => d.kind === "restore").at(-1);
  say(
    "F2 the undo still restores the whole cascade",
    undo && restored?.count === serverCount,
    `undo posted ${restored?.count ?? 0} of ${serverCount} ids`,
  );

  /* ── FINDING 2, the tester's own numbers: 21 rows here, 180 in total ──── */
  await page.waitForTimeout(2500);
  alsoHide = await page.evaluate(() =>
    [...document.querySelectorAll("[data-team-row]")]
      .map((r) => r.getAttribute("data-node-id"))
      .filter((id) => id && id !== document.querySelector("[data-team-row]")?.getAttribute("data-node-id"))
      .slice(0, 20),
  );
  note(`scenario B: cascade also carries ${alsoHide.length} ids that ARE rows here`);
  await clickX(page, target.id);
  await page.waitForTimeout(700);
  await clickX(page, target.id);
  await page.waitForTimeout(1500);
  const b = await page.evaluate(() => {
    const toast = [...document.querySelectorAll("div")]
      .map((d) => (d.innerText || "").trim())
      .filter((t) => /hidden/.test(t) && t.length < 300)
      .sort((a, b) => a.length - b.length)[0];
    const tray = [...document.querySelectorAll("button")]
      .map((x) => (x.innerText || "").trim())
      .find((t) => /dismissed · (show|hide)/.test(t));
    return { toast: toast ?? null, tray: tray ?? null };
  });
  const bTray = Number((b.tray || "").match(/^(\d+)/)?.[1] ?? NaN);
  const bLocal = Number((b.toast || "").match(/^(\d+) rows? hidden here/)?.[1] ?? NaN);
  note(`toast: ${JSON.stringify(b.toast)}`);
  note(`tray:  ${JSON.stringify(b.tray)}`);
  say(
    "F2 a 21-of-180 cascade: the toast's first number is the tray's number",
    bLocal === bTray && bLocal > 1,
    `toast "${bLocal} rows hidden here" vs tray "${bTray} dismissed"`,
  );
  say(
    "F2 …and the total is still the one the undo restores",
    /180 in total/.test(b.toast || "") && /undo restores all 180/.test(b.toast || ""),
    (b.toast || "").slice(0, 160),
  );
  await shot(page, "05-f2-21-of-180");

  fs.writeFileSync(
    path.join(__dirname, "f2-f3.json"),
    JSON.stringify({ target, after, serverCount, scenarioB: b, dismissLog, results }, null, 1),
  );
  await browser.close();
})();
