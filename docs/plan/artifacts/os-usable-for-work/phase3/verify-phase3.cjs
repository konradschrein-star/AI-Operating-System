#!/usr/bin/env node
/**
 * verify-phase3.cjs — the AFTER proof for round 300 (R38, R39, R40, R43).
 *
 * WHAT IT ASSERTS, and why each one is an assertion rather than an eyeball.
 *
 *   R38  The words "not built" (case-insensitive) are in the rendered DOM of
 *        GOALS, JOURNAL, MAP and LIBRARY, and the ELEMENT CARRYING THEM has a
 *        bounding box INSIDE THE INITIAL VIEWPORT. Presence in the DOM is not
 *        the test: the version this round replaced opened with 64px of top
 *        padding under a 25px title, so an honest line placed at the bottom of
 *        that card would have been below the fold on a short window and might
 *        as well not have been written. Measured at 1280×800 AND at 1280×600.
 *
 *   R39  All three statements render per surface — what it is FOR, what it
 *        NEEDS in order to exist, and WHETHER ANYONE IS COMING.
 *
 *   R40  `[data-nav-unbuilt]` is present for EXACTLY goals, journal, map and
 *        library, and absent on every built entry. Asserted at all three nav
 *        render sites, because the nav model lived in two places once before
 *        and round 1872's tester found 11 of 14 destinations unreachable at
 *        390px as a result: the left rail and the top strip at 1280, and the
 *        phone sheet at 390 where the rail is not mounted at all.
 *
 *   SEARCH is asserted from the other side. Its backend is built, mounted and
 *        answering (surface-determinations.md §5), so this script requires that
 *        it does NOT say "not built" while still showing the three statements.
 *        Applying the four-surface template to it would replace one wrong label
 *        with another, and only an inverse assertion catches that.
 *
 * N1 — NO SILENT FALLBACK. Every failure path throws and the process exits
 *      non-zero. No `catch {}` returning a default, no `?? 0`, no shot written
 *      from a page whose identity was not asserted first.
 *
 * THE ASSERTION THAT IS NOT OPTIONAL. `forge-control-web/middleware.ts` 307s
 *      every unauthenticated request to /signin. `assertPastTheWall()` runs
 *      after EVERY navigation — not once at startup — because a session can
 *      expire mid-run and because a click can navigate. An agent that skips it
 *      screenshots the login page and reports success.
 *
 * TWO SALTS (corpus commit 3f98e67). In auth.js v5 the session-cookie NAME is
 *      also the JWE salt, and the running server's AUTH_URL decides which name
 *      is used — not the port. A throwaway `next start` with an http AUTH_URL
 *      takes `authjs.session-token`; the live UI takes
 *      `__Secure-authjs.session-token`. The wrong salt fails as a 307 that is
 *      indistinguishable from an expired token, so the salt is named FIRST in
 *      the failure message.
 *
 * BUILD FIRST. `next start` serves the build that was on disk when `pnpm build`
 *      ran and does not watch files. A server left up across a code change
 *      serves the OLD bundle and this script reports "not built" as missing —
 *      which reads as "my change didn't work". See browser-harness-local.md §6.
 *
 * USAGE
 *   FORGE_RUN_ID=<12-hex> \
 *   BASE_URL=http://127.0.0.1:7783 \
 *   COOKIE_FILE=/tmp/session-cookie-phase3b.txt \
 *   ARTIFACT_DIR=docs/plan/artifacts/os-usable-for-work/phase3 \
 *     node docs/plan/artifacts/os-usable-for-work/phase3/verify-phase3.cjs
 *
 * ENV
 *   FORGE_RUN_ID   required. Upload dir under /opt/ai-os/uploads (N7).
 *   BASE_URL       required. The throwaway server. NEVER the live host.
 *   COOKIE_FILE    required. File holding the minted session JWT.
 *   COOKIE_NAME    default "authjs.session-token". See "TWO SALTS" above.
 *   COOKIE_SECURE  default "0". Must be "1" when COOKIE_NAME starts __Secure-.
 *   ARTIFACT_DIR   optional. If set, each shot is also copied here as
 *                  after-<label>.png.
 */

const fs = require("node:fs");
const path = require("node:path");

const PW_ROOT = "/opt/hermes-workspace/node_modules/playwright";
const PW_CACHE = "/root/.cache/ms-playwright";

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(
      `${name} is not set. This harness has no default for it — see the ENV block at the top of ${path.basename(__filename)}.`,
    );
  }
  return v.trim();
}

function chromiumExecutable() {
  if (!fs.existsSync(PW_CACHE)) {
    throw new Error(`playwright browser cache missing at ${PW_CACHE}`);
  }
  const candidates = fs
    .readdirSync(PW_CACHE)
    .filter((d) => d.startsWith("chromium"))
    .map((d) =>
      d.startsWith("chromium_headless_shell-")
        ? path.join(PW_CACHE, d, "chrome-headless-shell-linux64", "chrome-headless-shell")
        : path.join(PW_CACHE, d, "chrome-linux64", "chrome"),
    )
    .filter((p) => fs.existsSync(p));
  if (candidates.length === 0) {
    throw new Error(
      `no chromium binary under ${PW_CACHE} — expected chromium-*/chrome-linux64/chrome or chromium_headless_shell-*/…`,
    );
  }
  return candidates[0];
}

/** Compact UTC ISO-8601, e.g. 20260818T193000Z (N7). */
function stamp() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

const RUN_ID = required("FORGE_RUN_ID");
const BASE_URL = required("BASE_URL").replace(/\/$/, "");
const COOKIE_FILE = required("COOKIE_FILE");
const COOKIE_NAME = (process.env.COOKIE_NAME ?? "authjs.session-token").trim();
const COOKIE_SECURE = (process.env.COOKIE_SECURE ?? "0").trim() === "1";
const ARTIFACT_DIR = process.env.ARTIFACT_DIR ? process.env.ARTIFACT_DIR.trim() : null;

if (COOKIE_NAME.startsWith("__Secure-") && !COOKIE_SECURE) {
  throw new Error(
    `COOKIE_NAME=${COOKIE_NAME} requires COOKIE_SECURE=1; CDP rejects a __Secure- name with secure:false.`,
  );
}
if (/os\.schreinercontentsystems\.com|:7701\b/.test(BASE_URL)) {
  throw new Error(
    `BASE_URL=${BASE_URL} points at the LIVE UI. This is a build-phase harness (N4/N5): run it against a throwaway next start from this worktree.`,
  );
}

const UPLOAD_DIR = path.join("/opt/ai-os/uploads", RUN_ID);
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (ARTIFACT_DIR) fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

const cookieValue = fs.readFileSync(COOKIE_FILE, "utf8").trim();
if (!cookieValue) throw new Error(`${COOKIE_FILE} is empty — mint the session token first.`);

/** The four unbuilt NAV entries, reached the way Konrad reaches them. */
const NAV_SURFACES = [
  { key: "goals", navLabel: "GOALS", tag: "GOALS" },
  { key: "journal", navLabel: "JOURNAL", tag: "JOURNAL" },
  { key: "map", navLabel: "MAP", tag: "MAP" },
  { key: "library", navLabel: "LIBRARY", tag: "LIBRARY" },
];

/** The three statements R39 requires, by the headings the surface prints. */
const SECTION_HEADINGS = [
  "WHAT IT WOULD BE FOR",
  "WHAT IT NEEDS IN ORDER TO EXIST",
  "WHETHER ANYONE IS COMING",
];

/** The two window shapes R38 is measured at. 600 is the one that matters: the
 *  fold is only a real constraint on a short window. */
const VIEWPORTS = [
  { width: 1280, height: 800, label: "1280x800" },
  { width: 1280, height: 600, label: "1280x600" },
];

let failures = 0;
const log = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  const pass = a === e;
  if (!pass) failures += 1;
  const line = pass
    ? `PASS  ${label}`
    : `FAIL  ${label}\n        expected ${e}\n        actual   ${a}`;
  console.log(line);
  log.push({ label, pass, actual, expected });
}

/**
 * Past the wall AND actually mounted. A page that is authenticated but blank is
 * as misleading as the login page.
 *
 * `mountSelector` is the shell's proof of life at that width, and it is NOT the
 * same element at every width: above 900px the left rail is a `<nav>`, but
 * `useNarrowViewport` unmounts the rail below it and the only `<nav>` left in
 * the document belongs to the phone sheet, which is closed until it is opened.
 * Asserting `nav` at 390px therefore fails on a perfectly healthy page — which
 * is a wrong signpost, and this file exists partly to stop those.
 */
async function assertPastTheWall(page, where, mountSelector) {
  const url = page.url();
  if (/\/signin/.test(url)) {
    throw new Error(
      `[${where}] landed on ${url} — NOT past the auth wall. First suspect: the JWE salt. ` +
        `This run used COOKIE_NAME=${COOKIE_NAME} (salt must equal the cookie name). ` +
        `The throwaway http server takes "authjs.session-token"; a server with an https AUTH_URL ` +
        `takes "__Secure-authjs.session-token". Then check AUTH_SECRET and maxAge.`,
    );
  }
  const mounted = await page.locator(mountSelector).count();
  if (mounted === 0) {
    throw new Error(
      `[${where}] no "${mountSelector}" in the DOM at ${url} — the desktop shell did not mount.`,
    );
  }
}

/**
 * Read the placeholder back out of the DOM.
 *
 * The bounding box is taken from the DEEPEST element whose own text matches
 * /not built/i, so the rect belongs to the sentence itself and not to some
 * ancestor container that happens to span the whole page. `withinViewport` is
 * the R38 assertion: presence is not enough, it has to be on screen.
 */
async function probe(page, headings) {
  return page.evaluate((sectionHeadings) => {
    const RE = /not built/i;
    const all = Array.from(document.querySelectorAll("body *"));
    const matching = all.filter((el) => RE.test(el.textContent || ""));
    const deepest = matching.filter(
      (el) => !matching.some((other) => other !== el && el.contains(other)),
    );
    const target = deepest[0] ?? null;
    const rect = target ? target.getBoundingClientRect() : null;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const tagEl = document.querySelector("[data-placeholder-tag]");
    const banner = document.querySelector("[data-placeholder-banner]");
    const bannerRect = banner ? banner.getBoundingClientRect() : null;
    const marks = Array.from(document.querySelectorAll("[data-nav-unbuilt]")).map((el) =>
      el.getAttribute("data-nav-unbuilt"),
    );
    const railMarks = Array.from(
      document.querySelectorAll("nav [data-nav-unbuilt]"),
    ).map((el) => el.getAttribute("data-nav-unbuilt"));
    const body = document.body.innerText;
    return {
      placeholderTag: tagEl ? tagEl.getAttribute("data-placeholder-tag") : null,
      hasNotBuilt: RE.test(body),
      notBuiltText: target ? (target.textContent || "").trim().slice(0, 120) : null,
      notBuiltRect: rect
        ? { top: Math.round(rect.top), bottom: Math.round(rect.bottom), left: Math.round(rect.left), right: Math.round(rect.right) }
        : null,
      withinViewport: rect
        ? rect.top >= 0 && rect.bottom <= vh && rect.left >= 0 && rect.right <= vw
        : false,
      bannerState: banner ? banner.getAttribute("data-placeholder-banner") : null,
      bannerWithinViewport: bannerRect
        ? bannerRect.top >= 0 && bannerRect.bottom <= vh && bannerRect.left >= 0 && bannerRect.right <= vw
        : false,
      sectionsPresent: sectionHeadings.filter((h) => body.includes(h)),
      /* The exact thing that made the old screen read as broken. */
      hasComingSoon: /coming soon/i.test(body),
      marks: [...new Set(marks)].sort(),
      markNodeCount: marks.length,
      railMarks: [...new Set(railMarks)].sort(),
      viewport: { w: vw, h: vh },
      firstChars: body.slice(0, 200).replace(/\s+/g, " "),
    };
  }, headings);
}

async function shoot(target, label) {
  const file = `${stamp()}-${label}.png`;
  const dest = path.join(UPLOAD_DIR, file);
  await target.screenshot({ path: dest });
  const size = fs.statSync(dest).size;
  if (size < 2000) {
    throw new Error(`${dest} is ${size} bytes — that is not a rendered page.`);
  }
  if (ARTIFACT_DIR) fs.copyFileSync(dest, path.join(ARTIFACT_DIR, `${label}.png`));
  console.log(`  shot ${dest} (${size} bytes)`);
  return { label, path: dest, bytes: size, url: `/api/uploads/${RUN_ID}/${file}` };
}

async function assertServerUp() {
  const res = await fetch(`${BASE_URL}/desktop`, { redirect: "manual" }).catch((e) => {
    throw new Error(
      `${BASE_URL} is not answering (${e.cause?.code ?? e.message}). The throwaway ` +
        `next start is a background process with no supervisor and dies with its shell. ` +
        `Restart it with setsid — see browser-harness-local.md §1 step 4 — then re-run.`,
    );
  });
  /* AN ANONYMOUS 200 IS A FAILURE, NOT A CONVENIENCE — and this assertion is
   * here because tolerating it cost this task a full verification round.
   *
   * `middleware.ts` redirects EVERY unauthenticated request that is not
   * /api/auth, /signin, /favicon.ico or /_next/. So an anonymous GET /desktop
   * must be a 307. If it answers 200, the wall is DOWN: the usual cause is a
   * `next start` launched without AUTH_SECRET in its environment, where
   * `auth()` throws MissingSecret inside the middleware and the request falls
   * through to the page. The server then serves the whole app to anybody, the
   * session cookie is never consulted, and every /signin guard downstream is
   * inert — a green run that proved nothing about an authenticated surface.
   *
   * The tell is in the server log, not in the response:
   *     [auth][error] MissingSecret: Please define a `secret`.
   * The usual cause of THAT is `cd <dir> && set -a; . .env.local; set +a` — the
   * `&&` binds only to `set -a`, so a failed `cd` leaves the variables sourced
   * but UNEXPORTED and `next start` inherits none of them. */
  if (res.status === 200) {
    throw new Error(
      `${BASE_URL}/desktop answered 200 to an ANONYMOUS request. The auth wall is DOWN, so ` +
        `this run would prove nothing. middleware.ts 307s every unauthenticated request; a 200 ` +
        `means auth() threw inside it. Check the server log for "[auth][error] MissingSecret" ` +
        `and restart with AUTH_SECRET actually EXPORTED into next start's environment ` +
        `(set -a; . /opt/forge-ai-os/forge-control-web/.env.local; set +a — and check that any ` +
        `cd on that line succeeded).`,
    );
  }
  if (res.status !== 307) {
    throw new Error(`${BASE_URL}/desktop answered ${res.status}; expected 307 (the auth wall).`);
  }
  console.log(`preflight: ${BASE_URL}/desktop → ${res.status} (anonymous — the wall is up)`);
}

/** Open a fresh context at one viewport, cookie already attached. */
async function newDesktop(browser, viewport) {
  const ctx = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  await ctx.addCookies([
    {
      name: COOKIE_NAME,
      value: cookieValue,
      domain: "127.0.0.1",
      path: "/",
      httpOnly: true,
      secure: COOKIE_SECURE,
      sameSite: "Lax",
    },
  ]);
  const page = await ctx.newPage();
  const mountSelector = viewport.width >= 900 ? "nav" : 'button[title="All destinations"]';
  await page.goto(`${BASE_URL}/desktop`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(mountSelector, { timeout: 30_000 });
  await assertPastTheWall(page, `initial load @${viewport.label}`, mountSelector);
  await page.waitForTimeout(3500);
  return { ctx, page, mountSelector };
}

(async () => {
  await assertServerUp();
  const { chromium } = require(PW_ROOT);
  const executablePath = chromiumExecutable();
  console.log(`browser: ${executablePath}`);
  console.log(`target : ${BASE_URL}  cookie: ${COOKIE_NAME} (secure=${COOKIE_SECURE})`);

  const browser = await chromium.launch({
    executablePath,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const shots = [];
  const probes = {};
  try {
    for (const viewport of VIEWPORTS) {
      console.log(`\n════ ${viewport.label} ════════════════════════════════════`);
      const { ctx, page } = await newDesktop(browser, viewport);
      const shootHere = viewport.height === 800; // one set of artefacts, from the tall window

      /* ── R40 at the two desktop nav sites ─────────────────────────────────
       * At 1280 the left rail is mounted (useNarrowViewport cuts it below 900)
       * AND the top strip renders its three groups. LIBRARY is in `work`, so
       * the strip carries one marker and the rail carries all four. */
      const navProbe = await probe(page, SECTION_HEADINGS);
      check(
        `${viewport.label} · the marker is on exactly the four unbuilt entries`,
        navProbe.marks,
        ["goals", "journal", "library", "map"],
      );
      check(
        `${viewport.label} · …and the left rail alone carries all four`,
        navProbe.railMarks,
        ["goals", "journal", "library", "map"],
      );
      check(
        `${viewport.label} · …with LIBRARY also marked in the top strip (5 nodes, 4 keys)`,
        navProbe.markNodeCount,
        5,
      );
      /* ── R43 at the one place a marker can change a BUILT surface's behaviour
       * The top strip is horizontal and ALREADY overflows at 1280 before this
       * round; anything added to it pushes a built destination further off the
       * right edge. So the strip's marker is the 16px glyph rather than the
       * 48px word, and that is asserted rather than asserted-about: measure the
       * strip, hide the strip marker in the DOM, measure again. Only LIBRARY is
       * involved — goals, journal and map are in `recall`, which this strip
       * does not render. */
      if (shootHere) {
        const strip = await page.evaluate(async () => {
          const brand = Array.from(document.querySelectorAll("span")).find(
            (s) => s.textContent === "forge",
          );
          if (!brand) throw new Error("no `forge` wordmark — the top bar did not render");
          const bar = brand.closest("div").parentElement;
          const before = bar.scrollWidth;
          const marks = Array.from(document.querySelectorAll("[data-nav-unbuilt]")).filter(
            (el) => !el.closest("nav"),
          );
          marks.forEach((el) => {
            el.style.display = "none";
          });
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          const after = bar.scrollWidth;
          marks.forEach((el) => {
            el.style.display = "";
          });
          return { stripMarks: marks.length, withMarker: before, withoutMarker: after, client: bar.clientWidth };
        });
        check(
          "R43 · the top strip carries exactly one marker (LIBRARY; recall is not in this strip)",
          strip.stripMarks,
          1,
        );
        check(
          `R43 · …and it costs the strip under 20px (${strip.withoutMarker}px → ${strip.withMarker}px, container ${strip.client}px)`,
          strip.withMarker - strip.withoutMarker < 20,
          true,
        );
        check(
          "R43 · the strip already overflowed 1280 BEFORE this round's marker — pre-existing, reported not fixed",
          strip.withoutMarker > strip.client,
          true,
        );
        probes["top-strip@1280x800"] = strip;

        const navs = await page.locator("nav").count();
        if (navs !== 1) {
          throw new Error(
            `expected exactly one <nav> at ${viewport.width}px (the left rail); found ${navs}. ` +
              `The mobile nav-menu panel should not be mounted at this width — check useNarrowViewport.`,
          );
        }
        shots.push(await shoot(page.locator("nav").first(), "after-nav-rail"));
      }

      /* ── R38 + R39 on the four ────────────────────────────────────────── */
      for (const s of NAV_SURFACES) {
        const entry = page.locator("nav").getByText(s.navLabel, { exact: true }).first();
        if ((await entry.count()) === 0) {
          throw new Error(`nav rail has no entry labelled "${s.navLabel}" — nav-items.ts changed?`);
        }
        await entry.click();
        await page.waitForTimeout(1200);
        await assertPastTheWall(page, `${s.key} @${viewport.label}`, "nav");

        const p = await probe(page, SECTION_HEADINGS);
        /* Identity, before anything is asserted about the words on the screen.
           The nav chrome renders every label, so a body-text search for "GOALS"
           would pass while looking at TODAY. */
        if (p.placeholderTag !== s.tag) {
          throw new Error(
            `clicked ${s.navLabel} but the rendered placeholder is ` +
              `${p.placeholderTag === null ? "not a placeholder at all" : `"${p.placeholderTag}"`}, ` +
              `expected "${s.tag}". Body began: ${p.firstChars}`,
          );
        }
        check(`${viewport.label} · ${s.key} · R38 the words "not built" render`, p.hasNotBuilt, true);
        check(
          `${viewport.label} · ${s.key} · R38 …and their bounding box is inside the viewport`,
          { withinViewport: p.withinViewport, rect: p.notBuiltRect, vh: p.viewport.h },
          { withinViewport: true, rect: p.notBuiltRect, vh: viewport.height },
        );
        check(
          `${viewport.label} · ${s.key} · R38 the whole warning banner is above the fold`,
          p.bannerWithinViewport,
          true,
        );
        check(
          `${viewport.label} · ${s.key} · R38 it is the warning treatment, not a neutral card`,
          p.bannerState,
          "unbuilt",
        );
        check(
          `${viewport.label} · ${s.key} · R39 all three statements render`,
          p.sectionsPresent,
          SECTION_HEADINGS,
        );
        check(
          `${viewport.label} · ${s.key} · R39 "coming soon" is not on the screen`,
          p.hasComingSoon,
          false,
        );
        check(
          `${viewport.label} · ${s.key} · the marker survives navigation`,
          p.marks,
          ["goals", "journal", "library", "map"],
        );
        probes[`${s.key}@${viewport.label}`] = p;
        if (shootHere) shots.push(await shoot(page, `after-${s.key}`));
      }

      /* ── SEARCH, from the other side ──────────────────────────────────────
       * Reachable through exactly one non-UI path: a stored localStorage value
       * that passes isSurface(). No nav entry exists, so it gets no marker —
       * and its backend is LIVE, so it must NOT claim to be unbuilt. */
      await page.evaluate(() =>
        window.localStorage.setItem("forge.desktop.surface", JSON.stringify("search")),
      );
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForSelector("nav", { timeout: 30_000 });
      await assertPastTheWall(page, `search @${viewport.label}`, "nav");
      await page.waitForTimeout(2000);
      const sp = await probe(page, SECTION_HEADINGS);
      if (sp.placeholderTag !== "SEARCH") {
        throw new Error(
          `seeded localStorage forge.desktop.surface="search" and reloaded, but the SEARCH ` +
            `placeholder did not render. isSurface() or the render switch changed. ` +
            `Body began: ${sp.firstChars}`,
        );
      }
      check(
        `${viewport.label} · search · does NOT say "not built" — its engine is live`,
        sp.hasNotBuilt,
        false,
      );
      check(
        `${viewport.label} · search · is flagged unreachable, not unbuilt`,
        sp.bannerState,
        "unreachable",
      );
      check(
        `${viewport.label} · search · R39 all three statements still render`,
        sp.sectionsPresent,
        SECTION_HEADINGS,
      );
      check(
        `${viewport.label} · search · gets no nav marker: it has no nav entry`,
        sp.marks,
        ["goals", "journal", "library", "map"],
      );
      probes[`search@${viewport.label}`] = sp;

      await page.evaluate(() =>
        window.localStorage.setItem("forge.desktop.surface", JSON.stringify("today")),
      );
      await ctx.close();
    }

    /* ── R40 at the THIRD render site: the phone sheet ─────────────────────
     * Below 900px the left rail is not mounted, so the sheet is the only way
     * to reach anything. Round 1872 found 11 of 14 destinations unreachable at
     * 390px because the nav model lived in two places; a marker that renders
     * on two of three sites is the same defect one layer up. */
    console.log("\n════ 390x844 · the phone sheet ═══════════════════════════");
    {
      const { ctx, page } = await newDesktop(browser, { width: 390, height: 844, label: "390x844" });
      const menu = page.locator('button[title="All destinations"]');
      if ((await menu.count()) === 0) {
        throw new Error(
          'no button[title="All destinations"] at 390px — the phone nav did not mount; check useNarrowViewport.',
        );
      }
      await menu.click();
      await page.waitForSelector("[data-nav-menu-panel]", { timeout: 15_000 });
      await assertPastTheWall(page, "phone sheet @390x844", "[data-nav-menu-panel]");
      const sheet = await page.evaluate(() => {
        const inSheet = Array.from(
          document.querySelectorAll("[data-nav-menu-panel] [data-nav-unbuilt]"),
        ).map((el) => el.getAttribute("data-nav-unbuilt"));
        const items = Array.from(
          document.querySelectorAll("[data-nav-menu-item]"),
        ).map((el) => el.getAttribute("data-nav-menu-item"));
        return { inSheet: [...new Set(inSheet)].sort(), itemCount: items.length, items };
      });
      check("390px · the phone sheet marks the same four", sheet.inSheet, [
        "goals",
        "journal",
        "library",
        "map",
      ]);
      check("390px · …out of 18 destinations, so 14 carry nothing", sheet.itemCount, 18);
      check(
        "390px · …and no built destination is marked",
        sheet.items.filter((k) => sheet.inSheet.includes(k)).sort(),
        ["goals", "journal", "library", "map"],
      );
      shots.push(await shoot(page, "after-phone-sheet"));
      probes["phone-sheet@390x844"] = sheet;
      await ctx.close();
    }

    if (shots.length !== 6) {
      throw new Error(`expected 6 screenshots, produced ${shots.length}`);
    }
  } finally {
    await browser.close();
  }

  console.log(JSON.stringify({ run_id: RUN_ID, shots, probes }, null, 1));
  if (failures > 0) {
    console.error(`\n${failures} FAILURE(S) — phase 3 after-verification`);
    process.exit(1);
  }
  console.log(`\nALL PASS — ${log.length} assertions, ${shots.length} shots in ${UPLOAD_DIR}`);
})().catch((err) => {
  console.error(`FAILED: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
