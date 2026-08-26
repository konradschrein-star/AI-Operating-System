/**
 * novnc-bridge.ts — a typed handle on the noVNC instance running inside the
 * same-origin takeover iframe.
 *
 * noVNC 1.3.0 (`/usr/share/novnc`, Debian novnc 1:1.3.0-2) never publishes
 * `window.UI`: `app/ui.js` is an ES module (`export default UI`). Because the
 * iframe is same-origin (`/api/proxy/uploads/<id>/vnc/vnc.html`), the parent
 * can append a `<script type="module">` to the IFRAME document that imports
 * `./app/ui.js` — the relative specifier resolves against the iframe's own URL,
 * and the module map is per realm, so the import returns the SAME `UI` object
 * vnc.html already instantiated. R1 proved this from a parent frame
 * (docs/plan/aios-takeover-usable/research-keysym.md §1.2:
 * `sameInstanceOnReimport: true`, `parentWindowUI: "undefined"`).
 *
 * Facts this file relies on, all from R1 (§1, §1.3):
 *   - `UI.rfb` is set at ui.js:1027 on connect and CLEARED at ui.js:1111 on
 *     disconnect — a NEW object per connection. Never cache it: `rfb()` re-reads.
 *   - `updateVisualState` (ui.js:388-414) first REMOVES all of
 *     noVNC_connecting / noVNC_connected / noVNC_disconnecting /
 *     noVNC_reconnecting from `<html>`, then adds one. There is NO
 *     `noVNC_disconnected` class: 'disconnected' is the ABSENCE of all four
 *     once any of them has been seen. A MutationObserver on the iframe's
 *     documentElement fired 27 ms after a kernel-level socket kill.
 *   - `rfb.sendKey(keysym, code, down)` (rfb.js:408) writes the socket
 *     directly; DOM focus is irrelevant (R1 §2.4). With `down` omitted it sends
 *     down+up. It returns SILENTLY when not connected — callers must check
 *     `state() === 'connected'` first or the text vanishes without an error.
 *
 * No logging anywhere in this file: the object it hands out is the one that
 * carries passwords into the VM.
 */

export type ViewerState =
  | "init"
  | "connecting"
  | "connected"
  | "disconnecting"
  | "reconnecting"
  | "disconnected";

/** The subset of noVNC's `RFB` (core/rfb.js) this page drives. */
export interface RfbLike {
  /** rfb.js:408 — `down` omitted ⇒ press and release. `code` null ⇒ plain
   *  KeyEvent (no QEMU extended key; x11vnc does not support it anyway). */
  sendKey(keysym: number, code: string | null, down?: boolean): void;
  /** rfb.js:443 — sets the VNC server-side clipboard (x11vnc → X selection). */
  clipboardPasteFrom(text: string): void;
}

/** The subset of `app/ui.js`'s default export this page reads. */
interface NoVNCUILike {
  rfb?: RfbLike;
  connected?: boolean;
}

/** The name the injected module script publishes the UI object under, on the
 *  IFRAME's window (R1 §1.2: globals land on `f.contentWindow`, not the parent). */
export const NOVNC_HANDLE_GLOBAL = "__forgeNoVNC";

/** Same-frame window, extended with the handle the module script sets. */
interface HandleWindow extends Window {
  __forgeNoVNC?: NoVNCUILike;
}

export interface NoVNCBridge {
  /** The live RFB object, or undefined when there is no connection right now.
   *  Re-read on every call — the object is replaced per connect. */
  rfb(): RfbLike | undefined;
  state(): ViewerState;
  /** Subscribe to state transitions. Returns the unsubscribe function. The
   *  callback also fires once, synchronously, with the current state. */
  onState(cb: (state: ViewerState, previous: ViewerState) => void): () => void;
  /** Stop observing. Idempotent. After this, `state()` keeps its last value. */
  dispose(): void;
}

export class NoVNCBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoVNCBridgeError";
  }
}

/** How long after `attachNoVNC` is called the handle may take to appear
 *  before the attach is declared failed. The module script runs as soon as
 *  ui.js (already loaded by vnc.html) resolves — R1 measured well under 1 s. */
export const NOVNC_HANDLE_TIMEOUT_MS = 5_000;

const CLASS_TO_STATE: ReadonlyArray<readonly [string, ViewerState]> = [
  ["noVNC_connected", "connected"],
  ["noVNC_connecting", "connecting"],
  ["noVNC_disconnecting", "disconnecting"],
  ["noVNC_reconnecting", "reconnecting"],
];

/**
 * Derive the viewer state from `<html class="…">`. `seenAny` is whether any of
 * the four classes has ever been observed on this document: before that, an
 * empty class list means noVNC has not started yet ('init'); after it, an
 * empty class list is the only signal noVNC gives for 'disconnected'.
 */
export function stateFromClassList(classList: DOMTokenList | string, seenAny: boolean): ViewerState {
  const has = (cls: string): boolean =>
    typeof classList === "string" ? classList.split(/\s+/).includes(cls) : classList.contains(cls);
  for (const [cls, state] of CLASS_TO_STATE) {
    if (has(cls)) return state;
  }
  return seenAny ? "disconnected" : "init";
}

function iframeDocument(iframe: HTMLIFrameElement): Document {
  let doc: Document | null;
  try {
    doc = iframe.contentDocument;
  } catch (err) {
    throw new NoVNCBridgeError(
      `viewer iframe document is not accessible (${err instanceof Error ? err.message : "cross-origin"})`,
    );
  }
  if (!doc) throw new NoVNCBridgeError("viewer iframe has no document yet");
  if (doc.location.href === "about:blank") throw new NoVNCBridgeError("viewer iframe is still about:blank");
  if (!doc.documentElement) throw new NoVNCBridgeError("viewer iframe document has no root element");
  return doc;
}

function readHandle(iframe: HTMLIFrameElement): NoVNCUILike | undefined {
  const win = iframe.contentWindow as HandleWindow | null;
  if (!win) return undefined;
  return win.__forgeNoVNC;
}

/**
 * Inject the module shim (once per document) and resolve a bridge as soon as
 * the handle exists. Rejects with a NoVNCBridgeError after
 * NOVNC_HANDLE_TIMEOUT_MS — the caller MUST render that: a takeover page whose
 * text panel silently cannot reach noVNC is exactly the failure this project
 * exists to remove.
 *
 * Call it from the iframe's `load` event (the document must be vnc.html, not
 * about:blank). Calling it twice on the same document is safe: the script is
 * only appended when the handle is absent.
 */
export async function attachNoVNC(
  iframe: HTMLIFrameElement,
  timeoutMs: number = NOVNC_HANDLE_TIMEOUT_MS,
): Promise<NoVNCBridge> {
  const doc = iframeDocument(iframe);

  if (readHandle(iframe) === undefined) {
    const script = doc.createElement("script");
    script.type = "module";
    // Relative to the IFRAME document's URL → the same /app/ui.js vnc.html loaded.
    script.textContent = `import UI from './app/ui.js'; window.${NOVNC_HANDLE_GLOBAL} = UI;`;
    (doc.head ?? doc.documentElement).appendChild(script);
  }

  const started = Date.now();
  while (readHandle(iframe) === undefined) {
    if (Date.now() - started > timeoutMs) {
      throw new NoVNCBridgeError(
        `noVNC handle did not appear within ${timeoutMs} ms — the viewer document is ` +
          `${doc.location.pathname} and its module shim never ran (noVNC missing, wrong origin, or CSP?)`,
      );
    }
    await new Promise<void>((r) => setTimeout(r, 50));
  }

  return createBridge(iframe, doc);
}

function createBridge(iframe: HTMLIFrameElement, doc: Document): NoVNCBridge {
  const root = doc.documentElement;
  let seenAny = stateFromClassList(root.classList, false) !== "init";
  let current: ViewerState = stateFromClassList(root.classList, seenAny);
  const listeners = new Set<(s: ViewerState, prev: ViewerState) => void>();
  let disposed = false;

  const observer = new MutationObserver(() => {
    if (disposed) return;
    const raw = stateFromClassList(root.classList, false);
    if (raw !== "init") seenAny = true;
    const next = stateFromClassList(root.classList, seenAny);
    if (next === current) return;
    const prev = current;
    current = next;
    for (const cb of listeners) cb(next, prev);
  });
  observer.observe(root, { attributes: true, attributeFilter: ["class"] });

  return {
    rfb: () => {
      const ui = readHandle(iframe);
      return ui?.rfb;
    },
    state: () => current,
    onState: (cb) => {
      listeners.add(cb);
      cb(current, current);
      return () => {
        listeners.delete(cb);
      };
    },
    dispose: () => {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      listeners.clear();
    },
  };
}
