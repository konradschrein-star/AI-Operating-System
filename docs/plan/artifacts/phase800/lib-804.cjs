/**
 * lib-804.cjs — what round 804's four protocols share.
 *
 * Round 804 is the EVIDENCE round for phase 800. It changes no application
 * code; every file it writes lives in this directory. Four protocols
 * (`composer-autogrow`, `secret-sentinel`, `note-injection`, `capture-800`)
 * need the same three things, so they are here once rather than four times:
 *
 *   1. the phase-700 harness, with its OUT_DIR steered at this directory;
 *   2. `resolveOne` — the hook-or-fail element resolver (see below);
 *   3. the composer/secret-panel locators every protocol drives.
 *
 * ── WHY `resolveOne` EXISTS ───────────────────────────────────────────────
 *
 * Round 803 found the round-801 canvas instrument DEAD on the merged tree: its
 * selector was `div[style*="45%"]`, and `main` had replaced the fixed
 * `flex: 1 1 45%` wrapper with a draggable split. Zero nodes matched and the
 * run died on a 20 s `waitForSelector`. It failed loudly, which is the only
 * reason it cost minutes instead of a bogus verdict — but the class of bug is
 * "identify a DOM node by a style literal", and that trap springs again every
 * time this UI is restyled.
 *
 * The operator's instruction for this round was to add `data-testid` hooks to
 * the components and repoint every instrument at them. That is APPLICATION
 * CODE and this round's own brief forbids touching any (`README.md` §6 states
 * the conflict and what was done about it). So this file delivers the half
 * that is legitimately an instrument concern:
 *
 *   - every locator asks for `[data-testid="…"]` FIRST, so the day the hook
 *     lands in the component the instruments pick it up with no edit;
 *   - the fallback is structural or semantic (an element's role, its
 *     placeholder, its button label) and NEVER a colour, a flex value, a width
 *     or any other style literal;
 *   - a match count that is not exactly 1 is a NAMED FAILURE — `hook
 *     composer-input matched 0 nodes (tried: …)` — instead of a timeout or,
 *     far worse, a silently wrong measurement off the wrong node.
 *
 * That third point is the operator's assertion #3, delivered at the only layer
 * this round is allowed to touch.
 *
 * ── SERVERS ───────────────────────────────────────────────────────────────
 *
 *   BASE   :7817  isolated `next build` + `next start` of THIS WORKTREE'S
 *                 WORKING COPY (`/tmp/p800-804-web`), built with
 *                 FORGE_CONTROL_URL=http://127.0.0.1:7814.
 *   API    :7814  this round's OWN `scripts/checks/serve-v3-7798.ts`, started
 *                 with `SECRET_STORE_DIR=/tmp/p800-store-804`.
 *
 *                 THE PORT AND THE STORE ARE THE SAME DECISION. A harness was
 *                 already up on :7798 when this round started, and
 *                 `/proc/<pid>/environ` showed it carried no SECRET_STORE_DIR
 *                 — i.e. it writes to `/opt/ai-os/.secrets/store`, Konrad's
 *                 REAL credentials. Protocol 2 and 3 exercise the secret WRITE
 *                 paths. Borrowing that harness would have raised real
 *                 "for Konrad" flags on his real keys, and killing another
 *                 round's server is forbidden by phase 700's convention. So
 *                 this round started its own on a free port, which is exactly
 *                 the case `SERVE_V3_PORT` was added for in round 802.
 *   GROUND :7700  the LIVE forge-control. Read-only GET, and this round makes
 *                 none — it is inherited from lib-703 and left unused.
 *
 * NFU8: playwright comes from lib-703's absolute path into
 * /opt/hermes-workspace and is not a dependency of either repo.
 */

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/* ── OUT_DIR, before lib-703 is required ──────────────────────────────────
 *
 * Round 705's non-destructive rule is binding here (phase700/README §2 step E):
 * without `--write` a rerun writes to /tmp and leaves `git status --porcelain`
 * untouched. lib-703 derives its own OUT_DIR from `__dirname` — phase 700's —
 * at require time, so a phase-800 artifact would land in phase700/. Steer it
 * first, then re-state `finish` against this directory. Same convention
 * `canvas-open.cjs` established in round 801; same stdout, same exit code. */
const SRC_DIR = __dirname;
const WRITE_IN_PLACE =
  process.argv.includes("--write") || process.env.PHASE800_WRITE === "1";
const OUT_DIR =
  process.env.PHASE800_OUT_DIR ??
  (WRITE_IN_PLACE ? SRC_DIR : path.join(os.tmpdir(), "phase800-out"));
if (OUT_DIR !== SRC_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });
process.env.PHASE700_OUT_DIR = OUT_DIR;

const L = require("../phase700/lib-703.cjs");

/** lib-703's `finish`, re-pointed at this directory. */
function finish800(fileName, payload, failures) {
  const out = path.join(OUT_DIR, fileName);
  fs.writeFileSync(out, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`} → ${out}`);
  if (OUT_DIR !== SRC_DIR) {
    console.log(`      committed evidence left untouched (${path.join(SRC_DIR, fileName)})`);
    console.log(`      diff -u "${path.join(SRC_DIR, fileName)}" "${out}"`);
    console.log(`      re-record in place with:  node ${process.argv[1]} --write`);
  }
  process.exit(failures === 0 ? 0 : 1);
}

/* ── Hooks ────────────────────────────────────────────────────────────────
 *
 * Each entry is a hook NAME plus the ordered list of ways to find it. The
 * `data-testid` form is first in every list and matches nothing today; it is
 * there so that adding the attribute to the component is the whole change.
 *
 * Read the fallbacks as a promise about what they do NOT contain: no `#hex`,
 * no `rgba(`, no `flex`, no `min-width`, no pixel value. They are the
 * element's own semantics — what it IS — which is the only property of a node
 * that a restyle cannot move.
 */
const HOOKS = {
  /** The chat composer's textarea (ChatSurface.tsx:1856). Fallback is its
   *  placeholder, which is functional copy tied to what the control does; both
   *  variants are listed because the string changes while the engine runs. */
  "composer-input": [
    'textarea[data-testid="composer-input"]',
    'textarea[placeholder*="Enter to send"]',
    'textarea[placeholder*="engine working"]',
  ],
  /** The "secret" button beside the composer (ChatSurface.tsx:1911). Fallback
   *  is its accessible name — `title` is stable API-ish text, and the two
   *  variants are the empty and pending states. */
  "secret-button": [
    '[data-testid="secret-button"]',
    'button[title^="Store a credential"]',
    'button[title^="waiting for"]',
  ],
  /** The SecretField panel (SecretField.tsx:156), located by the one control
   *  only it owns: the credential textarea's placeholder. `closest('div')`
   *  climbing is done by the caller, not encoded here. */
  "secret-panel-value": [
    '[data-testid="secret-value"]',
    'textarea[placeholder^="paste the secret here"]',
  ],
  /** SecretField's submit button. Its LABEL is mode-dependent — "answer
   *  request" when an agent asked, "store secret" free-form — so both are
   *  listed; a protocol that cares which mode it is in asserts the text
   *  separately rather than inferring it from which candidate matched. */
  "secret-submit": [
    '[data-testid="secret-submit"]',
    'button:text-is("answer request")',
    'button:text-is("store secret")',
  ],
  /** SecretField's name input — read-only in answer mode. */
  "secret-panel-name": [
    '[data-testid="secret-name"]',
    'input[placeholder^="name — e.g."]',
  ],
  /** The composer's send button (ChatSurface.tsx:1981). Fallback is its own
   *  label, matched exactly so it cannot pick up "send" inside a longer
   *  string; the second variant is the in-flight label. */
  "composer-send": [
    '[data-testid="composer-send"]',
    'button:text-is("send")',
    'button:text-is("…")',
  ],
  /** EngineControls' collapsed trigger (ChatSurface.tsx:1330). */
  "engine-controls": [
    '[data-testid="engine-controls"]',
    'button[title="Engine model + effort for this run"]',
  ],
  /**
   * The open canvas.
   *
   * ROUND 803'S SELECTOR IS DELIBERATELY NOT REUSED. `canvas-open.cjs` finds
   * this pane with `div[style*="min-width: 320px"]` — itself a repair of round
   * 801's `div[style*="45%"]`, which `main`'s draggable-split rewrite had
   * already killed. Both are style literals, and this UI is under active
   * redesign; the second one will die exactly like the first.
   *
   * `.excalidraw` is the editor's OWN root class — part of the library's
   * public contract, the same thing its documented CSS customisation hooks
   * target. It says "the Excalidraw editor is mounted here", which is the
   * fact being asserted, and no restyle of this app can move it.
   */
  "canvas-pane": ['[data-testid="canvas-pane"]', ".excalidraw"],
  /** The header toggle that opens the canvas. Matched by its accessible name. */
  "canvas-toggle": ['[data-testid="canvas-toggle"]', 'button:text-is("CANVAS")'],
};

/**
 * Resolve a hook to EXACTLY ONE element handle, or throw with a message that
 * says which hook, how many nodes each candidate matched, and what was tried.
 *
 * This is the assertion the operator asked every instrument to carry. It is
 * deliberately not a `waitForSelector`: waiting turns "the hook is gone" into
 * a 20-second timeout whose message names a selector rather than a cause.
 * Callers that genuinely need to wait for the app to settle do so explicitly
 * (`openChat` already waits on both zones) and then resolve.
 *
 * `>1` fails as loudly as `0`. A hook that matches two nodes is how an
 * instrument silently starts measuring the wrong one — the exact failure mode
 * that a match-count assertion exists to prevent.
 */
async function resolveOne(page, hookName, { root = null } = {}) {
  const candidates = HOOKS[hookName];
  if (!candidates) throw new Error(`resolveOne: no hook named ${JSON.stringify(hookName)}`);
  const counts = [];
  for (const selector of candidates) {
    const scope = root ?? page;
    const found = await scope.$$(selector);
    counts.push({ selector, matched: found.length });
    if (found.length === 1) return { handle: found[0], selector, tried: counts };
    if (found.length > 1) {
      throw new Error(
        `hook ${hookName} matched ${found.length} nodes via ${selector} — an instrument ` +
          `cannot know which one is the subject. Tried: ${JSON.stringify(counts)}`,
      );
    }
  }
  throw new Error(
    `hook ${hookName} matched 0 nodes. Tried: ${JSON.stringify(counts)}. ` +
      `If the component moved, repoint HOOKS in lib-804.cjs — or better, add ` +
      `data-testid="${hookName}" to it, which is what the first candidate expects.`,
  );
}

/** The metrics `useAutogrow` derives its row heights from, read off the live
 *  element. Returned as numbers so a protocol can do arithmetic rather than
 *  quote a derivation. */
async function readBoxMetrics(handle) {
  return handle.evaluate((el) => {
    const cs = getComputedStyle(el);
    const num = (raw) => {
      const n = parseFloat(raw);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      fontSizePx: num(cs.fontSize),
      lineHeightPx: num(cs.lineHeight),
      lineHeightRaw: cs.lineHeight,
      paddingTopPx: num(cs.paddingTop),
      paddingBottomPx: num(cs.paddingBottom),
      borderTopPx: num(cs.borderTopWidth),
      borderBottomPx: num(cs.borderBottomWidth),
      boxSizing: cs.boxSizing,
      rowsAttr: Number(el.getAttribute("rows")),
    };
  });
}

/** Everything about the element's box that an assertion in this round reads. */
async function readBox(handle) {
  return handle.evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    return {
      offsetHeight: el.offsetHeight,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
      styleHeight: el.style.height,
      overflowY: cs.overflowY,
      /* The honest test for "is it scrolling internally": content taller than
       * the visible box. `overflow-y: auto` alone proves nothing — it is what
       * the hook WROTE, not what the browser DID. */
      scrollbarPresent: el.scrollHeight > el.clientHeight,
      rectHeight: Number(r.height.toFixed(3)),
      rectWidth: Number(r.width.toFixed(3)),
    };
  });
}

/** `rowsToPx` from useAutogrow.ts:85, recomputed here from MEASURED metrics.
 *  This is not a re-derivation of the hypothesis the round-801 builder wrote
 *  down — every input comes from getComputedStyle on the running element. */
function rowsToPx(m, rows) {
  const chrome =
    m.boxSizing === "border-box"
      ? m.paddingTopPx + m.paddingBottomPx + m.borderTopPx + m.borderBottomPx
      : 0;
  return Math.round(m.lineHeightPx * rows + chrome);
}

/** Type `rows` lines into the composer, replacing whatever is there.
 *  Uses real keyboard input (Shift+Enter for the newlines) rather than
 *  `fill()` so the value arrives through the same onChange path a person's
 *  typing does — `fill()` sets the value in one shot and would not prove the
 *  hook runs per keystroke. */
async function typeLines(page, handle, rows, word = "x") {
  await handle.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  for (let i = 0; i < rows; i++) {
    if (i > 0) await page.keyboard.press("Shift+Enter");
    await page.keyboard.type(`${word}${i}`);
  }
  /* One frame for the layout effect to land. useAutogrow writes the height in
   * useLayoutEffect, so it is done before paint — this waits for the paint. */
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

/** Clear the composer the way Ctrl+A/Delete does, and settle a frame. */
async function clearComposer(page, handle) {
  await handle.click();
  await page.keyboard.press("Control+a");
  await page.keyboard.press("Delete");
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => r(null))));
}

/**
 * Compare two element screenshots by their DECODED PIXELS, inside the browser.
 *
 * WHY NOT COMPARE THE PNG BYTES. Round 804's first U32 attempt hashed the two
 * buffers and failed. Investigation (README §3.1, "the U32 instrument was
 * wrong") showed the send button's box was byte-for-byte the same rect in every
 * state — and that two screenshots of the SAME UNCHANGED STATE also produced
 * different PNG bytes. Chromium's encoder output is not deterministic at that
 * level, so `sha256(png)` is a coin flip dressed as a gate: it fails honest
 * builds and would pass on a retry.
 *
 * Decoded pixels are the thing U32 is actually about. The comparison runs in
 * the page — an `Image` plus a `<canvas>` — because Chromium is already here
 * and is a correct PNG decoder; pulling in pngjs/pixelmatch would add a
 * dependency for a decode that the browser under test can already do (NFU8).
 *
 * Returns the differing-pixel COUNT and the max per-channel delta, so a caller
 * can separate rasterisation noise (delta ≤ 2 on a handful of edge pixels)
 * from a real visual change (delta in the hundreds, across the whole box)
 * rather than being told a single yes/no.
 */
async function pixelDiff(page, aBase64, bBase64) {
  return page.evaluate(async ([a, b]) => {
    const load = (d) =>
      new Promise((res, rej) => {
        const img = new Image();
        img.onload = () => res(img);
        img.onerror = () => rej(new Error("could not decode screenshot PNG"));
        img.src = `data:image/png;base64,${d}`;
      });
    const [ia, ib] = await Promise.all([load(a), load(b)]);
    if (ia.width !== ib.width || ia.height !== ib.height) {
      return {
        sameSize: false,
        a: { w: ia.width, h: ia.height },
        b: { w: ib.width, h: ib.height },
        differingPixels: -1,
        totalPixels: -1,
        maxChannelDelta: -1,
      };
    }
    const pixels = (img) => {
      const c = document.createElement("canvas");
      c.width = img.width;
      c.height = img.height;
      const cx = c.getContext("2d");
      cx.drawImage(img, 0, 0);
      return cx.getImageData(0, 0, img.width, img.height).data;
    };
    const pa = pixels(ia);
    const pb = pixels(ib);
    let differing = 0;
    let maxDelta = 0;
    for (let i = 0; i < pa.length; i += 4) {
      let d = 0;
      for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(pa[i + k] - pb[i + k]));
      if (d !== 0) {
        differing++;
        if (d > maxDelta) maxDelta = d;
      }
    }
    return {
      sameSize: true,
      differingPixels: differing,
      totalPixels: pa.length / 4,
      maxChannelDelta: maxDelta,
    };
  }, [aBase64, bBase64]);
}

/** Set the app's theme the way capture-700.cjs did — the app's real mechanism
 *  (`app/theme.css:85`, `app/tokens.ts:103`), not a stylesheet override. */
async function setTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.dataset.theme = t;
  }, theme);
  await page.waitForTimeout(400);
}

/** The sampled background, recorded beside every screenshot so a reviewer can
 *  tell the two themes apart without opening the PNGs. */
async function sampleBackground(page) {
  return page.evaluate(() => ({
    body: getComputedStyle(document.body).backgroundColor,
    theme: document.documentElement.dataset.theme ?? "(unset)",
  }));
}

module.exports = {
  ...L,
  HOOKS,
  OUT_DIR,
  SRC_DIR,
  WRITE_IN_PLACE,
  clearComposer,
  finish800,
  pixelDiff,
  readBox,
  readBoxMetrics,
  resolveOne,
  rowsToPx,
  sampleBackground,
  setTheme,
  typeLines,
};
