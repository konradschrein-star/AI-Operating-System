"use client";

/**
 * TextToVM — the always-visible text panel under the noVNC canvas.
 *
 * Konrad pastes into THIS textarea with the phone's own paste (no permission
 * involved), taps Send, and the text reaches the VM. It exists because the
 * "Paste to VM" button calls `navigator.clipboard.readText()`, which is
 * Chromium-only in practice — absent in Firefox, restricted on iOS Safari —
 * so on his phone that button cannot work by construction. This path needs
 * no clipboard API at all.
 *
 * Two mechanisms, a segmented control, default = Type keys:
 *   Type keys        — one RFB KeyEvent pair (down+up) per code point through
 *                      `rfb.sendKey(keysym, null)` (noVNC core/rfb.js:408),
 *                      KEY_DELAY_MS apart, REMAP_KEY_DELAY_MS around any
 *                      keysym the VM keymap lacks (vm-keys.ts keyGapMs). Works
 *                      on login forms that block paste. Lands wherever the
 *                      VM's keyboard focus is. Reports "sent N keys", never
 *                      "typed": the page cannot see what arrived.
 *   Set VM clipboard — `rfb.clipboardPasteFrom(text)` (rfb.js:443): the VNC
 *                      server clipboard, then Ctrl+V inside the VM. Same
 *                      path the header's Paste-to-VM button drives.
 *
 * ── WHAT WAS VERIFIED (R1, docs/plan/aios-takeover-usable/research-keysym.md,
 *    2026-08-26, one Xvfb/x11vnc 0.9.16/Chrome 148 stack on an idle VPS) ──
 *   ✓ ASCII incl. shifted symbols `Hello, World! @#$%^&*()` — byte-exact.
 *   ✓ Latin-1 umlauts and ß, and the euro sign (U+20AC) via the keysym table:
 *     `Pässwörd ßÄÖÜ` + U+20AC.
 *   ✓ "\n" as XK_Return inside a textarea: value byte-exact `line1\nline2`.
 *   ✓ "\r\n" → ONE Return (R1 §2.5); a lone "\r" is normalised the same way.
 *   ✓ Emoji 🙂 as the Unicode keysym 0x0101f642 — ONE input event, exact.
 *   ✓ 300 / 1000 / 3000-character bursts at 0 ms delay — 5/5, 3/3, 3/3.
 *   ✓ Sending while the PARENT page's textarea has DOM focus (this exact
 *     layout): sendKey writes the socket, DOM focus is irrelevant (§2.4).
 *   ✓ "\t" as XK_Tab: it MOVES FOCUS to the next field (§2.2 d). Kept on
 *     purpose — `user⇥password` is the login case — and said so in the hint.
 *   ✓ B1 smoke (2026-08-26, real Chrome 390×844 → next dev → forge-control
 *     upgrade pipe → r1-keysym stack): `Pässwörd ßÄÖÜ` U+20AC `\nline2 🙂 Straße #7
 *     (Köln) & Co.` — 46 code points — echoed back byte-exact from the VM
 *     textarea; Send ⏎ appended one newline; typing still works through the
 *     NEW iframe after a killed socket was re-minted.
 *   ✓ Clipboard mode is LATIN-1 ONLY on this stack (B1 clip-probe): Ä é ü ß
 *     land in the X CLIPBOARD as c4 e9 fc df; U+20AC became 0xac and 🙂 "=B"
 *     (noVNC 1.3.0 legacy ClientCutText; x11vnc 0.9.16 offers no extended-
 *     clipboard notify). So clipboard mode REFUSES text with any code point
 *     above U+00FF and points at Type keys, which carries all of them.
 *   ✓ UNDER LOAD (B5, then B8 — evidence-text-input.md §B8): with a 63-process
 *     tsc storm beside the stack (loadavg 30–54 on 16 cores) a keysym the VM
 *     keymap LACKS (ß, ä, the euro sign, …) is dropped roughly once per ~80 sent, at 4 ms
 *     and at 50 ms alike — the race is inside x11vnc (`-add_keysyms`:
 *     XChangeKeyboardMapping then the fake press, no XSync) and no browser-
 *     side delay can split it. Plain ASCII was never dropped. Hence the
 *     feedback says "sent N keys — arrival not verified", never "typed".
 * ── WHAT WAS NOT VERIFIED ──
 *   ✗ ARRIVAL. `rfb.sendKey` writes a WebSocket frame; nothing on this page
 *     can read the VM's DOM or X11 focus back. Every count here is a count
 *     of frames written, and the wording says so.
 *   ✗ Non-Latin scripts beyond the table (CJK IME composition, RTL shaping).
 *   ✗ A non-US X keymap (a `de` layout would remove the remap for umlauts
 *     entirely — supervisor-side, not this file).
 *   ✗ Any Chrome field other than a textarea / input (rich editors may
 *     debounce or transform bursts).
 *   ✗ Which VM widget holds focus. The page cannot see X11 focus. R1 §3.1:
 *     right after launch it is Chrome's OMNIBOX, where Return submits the
 *     text to Google as a search — so Send NEVER appends Return; "Send ⏎"
 *     is a separate, explicit button, and the hint says tap the field first.
 *
 * NEVER LOGGED. No console.* in this file, no fetch, no error message that
 * contains the text; progress is counts only ('sending 37/120'). The text goes
 * browser → WebSocket → x11vnc as RFB frames that forge-control pipes without
 * parsing. Keep it that way.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { tokens } from "../../tokens";
import type { NoVNCBridge } from "./novnc-bridge";
import { XK_RETURN, keyGapMs, textToKeyEvents } from "./vm-keys";

export type SendMode = "type" | "clipboard";

export interface TextToVMProps {
  /** The live bridge, re-read per send (noVNC replaces `rfb` per connection). */
  getBridge: () => NoVNCBridge | null;
  /** Rendered state, for enabling Send. The send loop re-checks the bridge. */
  connected: boolean;
  /** Extra buttons rendered in the action row (the surface's own controls). */
  extraActions?: React.ReactNode;
  /** Initial visibility of the input (the toggle is always rendered). */
  initiallyHidden?: boolean;
}

interface Progress {
  sent: number;
  total: number;
}

interface Feedback {
  text: string;
  isError: boolean;
}

/** ≥44 px: Apple HIG / Android touch target minimum. Every control here. */
export const TOUCH_MIN_PX = 44;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Code points the legacy VNC clipboard cannot carry (anything above U+00FF;
 *  \t \n \r pass). Exported for the check script. */
export function countOutsideLatin1(text: string): number {
  let n = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp > 0xff) n++;
  }
  return n;
}

export function TextToVM({ getBridge, connected, extraActions, initiallyHidden = false }: TextToVMProps) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<SendMode>("type");
  const [hidden, setHidden] = useState(initiallyHidden);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const sendingRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!feedback || feedback.isError) return;
    const timer = setTimeout(() => setFeedback(null), 6_000);
    return () => clearTimeout(timer);
  }, [feedback]);

  const say = useCallback((t: string, isError = false) => setFeedback({ text: t, isError }), []);

  /** The connected RFB object, or null with the reason already rendered. */
  const liveRfb = useCallback(() => {
    const bridge = getBridge();
    if (!bridge) {
      say("viewer not attached yet — nothing sent", true);
      return null;
    }
    if (bridge.state() !== "connected") {
      say(`viewer is ${bridge.state()} — nothing sent`, true);
      return null;
    }
    const rfb = bridge.rfb();
    if (!rfb) {
      say("viewer has no RFB object — nothing sent", true);
      return null;
    }
    return { bridge, rfb };
  }, [getBridge, say]);

  const typeKeys = useCallback(
    async (withReturn: boolean) => {
      if (sendingRef.current) return;
      const live = liveRfb();
      if (!live) return;
      const events = textToKeyEvents(text);
      if (withReturn) events.push({ keysym: XK_RETURN });
      if (events.length === 0) {
        say("nothing to type", true);
        return;
      }
      sendingRef.current = true;
      setFeedback(null);
      const total = events.length;
      setProgress({ sent: 0, total });
      try {
        for (let i = 0; i < total; i++) {
          const { bridge } = live;
          const rfb = bridge.rfb();
          if (!rfb || bridge.state() !== "connected") {
            say(`sent ${i} of ${total} keys — viewer disconnected`, true);
            return;
          }
          rfb.sendKey(events[i].keysym, null); // down + up
          setProgress({ sent: i + 1, total });
          // A keysym the VM keymap lacks (ä ß, the euro sign, …) gets
          // REMAP_KEY_DELAY_MS on both sides; plain ASCII keeps KEY_DELAY_MS.
          // See vm-keys.ts.
          const gap = keyGapMs(events[i].keysym, i + 1 < total ? events[i + 1].keysym : null);
          if (gap > 0) await sleep(gap);
        }
        // "sent", never "typed": sendKey writes a WebSocket frame and nothing
        // on this page can see whether Chrome inside the VM received it. B5
        // measured a lost ß under CPU load while the old wording said "typed
        // 30 keys" — a claim of arrival the page cannot make.
        say(`sent ${total} key${total === 1 ? "" : "s"} to the VM${withReturn ? " + Enter" : ""} — arrival not verified, check the field`);
        setText("");
      } finally {
        sendingRef.current = false;
        setProgress(null);
      }
    },
    [liveRfb, text, say],
  );

  const setClipboard = useCallback(() => {
    if (sendingRef.current) return;
    if (text.length === 0) {
      say("nothing to send", true);
      return;
    }
    // Measured 2026-08-26 (B1 clip-probe, r1-keysym stack): the VNC clipboard
    // is Latin-1 by protocol here. noVNC 1.3.0 falls back to the legacy
    // ClientCutText (low byte of each UTF-16 unit) because x11vnc 0.9.16 does
    // not advertise the extended-clipboard NOTIFY action; Ä é ü ß arrive
    // byte-exact (c4 e9 fc df), U+20AC arrives as 0xac ("¬") and 🙂 as "=B".
    // A silently mangled password is the worst outcome, so refuse instead.
    const outside = countOutsideLatin1(text);
    if (outside > 0) {
      say(`${outside} character${outside === 1 ? "" : "s"} outside Latin-1 (the euro sign, emoji, …) cannot travel on the VNC clipboard — use Type keys`, true);
      return;
    }
    const live = liveRfb();
    if (!live) return;
    live.rfb.clipboardPasteFrom(text);
    say(`VM clipboard set (${text.length} chars) — paste inside the VM with Ctrl+V`);
    setText("");
  }, [liveRfb, text, say]);

  const send = useCallback(() => {
    if (mode === "type") void typeKeys(false);
    else setClipboard();
  }, [mode, typeKeys, setClipboard]);

  const sending = progress !== null;
  const canSend = connected && !sending && text.length > 0;

  if (hidden) {
    return (
      <div className="mono fg-ttv-panel" data-text-to-vm="hidden" style={panelStyle}>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <button
            type="button"
            data-text-to-vm-toggle
            onClick={() => setHidden(false)}
            className="mono"
            style={{ ...bigButton, flex: 1, background: tokens.accent, color: tokens.accentInk, border: "none" }}
          >
            Show text input
          </button>
          {extraActions}
        </div>
      </div>
    );
  }

  return (
    <div className="mono fg-ttv-panel" data-text-to-vm="shown" style={panelStyle}>
      <style>{`
        .fg-ttv-panel textarea::placeholder { color: ${tokens.textMuted}; }
        .fg-ttv-actions { display: flex; gap: 8px; flex-wrap: wrap; }
        .fg-ttv-actions > * { flex: 1 1 120px; }
        @media (max-width: 640px) {
          /* Bottom sheet of fixed height: the iframe above takes the rest.
             Header 16 + textarea 80 + three 44 px action rows + gaps/padding. */
          .fg-ttv-panel[data-text-to-vm="shown"] { height: 292px; overflow: hidden; }
          .fg-ttv-actions > [data-text-to-vm-send] { flex-basis: 100%; }
        }
      `}</style>

      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span style={{ fontSize: 11, letterSpacing: "0.1em", color: tokens.accent, flexShrink: 0 }}>TEXT → VM</span>
        {/* The hint yields to feedback/progress: one line, and the message that
            matters is whichever is newest, not a truncated pair of both. */}
        {!feedback && !progress && (
          <span
            data-text-to-vm-hint
            style={{ fontSize: 11, color: tokens.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {mode === "type"
              ? "Tap the target field in the VM first. Tab moves to the next field."
              : "Then paste inside the VM with Ctrl+V."}
          </span>
        )}
        {feedback && (
          <span
            data-text-to-vm-feedback
            role="status"
            style={{
              fontSize: 11,
              color: feedback.isError ? tokens.warn : tokens.ok,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              marginLeft: "auto",
            }}
          >
            {feedback.text}
          </span>
        )}
        {progress && (
          <span data-text-to-vm-progress style={{ fontSize: 11, color: tokens.info, whiteSpace: "nowrap", marginLeft: "auto" }}>
            sending {progress.sent}/{progress.total}
          </span>
        )}
      </div>

      <textarea
        ref={textareaRef}
        data-text-to-vm-input
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        disabled={sending}
        placeholder={mode === "type" ? "Paste or type here, then Send" : "Text for the VM clipboard"}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        aria-label="Text to send into the VM"
        style={{
          width: "100%",
          boxSizing: "border-box",
          fontSize: 16, // iOS does not zoom a 16 px field
          lineHeight: 1.3,
          padding: "8px 10px",
          background: tokens.inputBg,
          color: tokens.text,
          border: `1px solid ${tokens.borderSoft}`,
          borderRadius: 6,
          resize: "none",
          fontFamily: "inherit",
        }}
      />

      <div className="fg-ttv-actions">
        <div
          role="radiogroup"
          aria-label="How to send"
          data-text-to-vm-mode={mode}
          style={{ display: "flex", flex: "1 1 200px", border: `1px solid ${tokens.borderDivider}`, borderRadius: 6, overflow: "hidden" }}
        >
          <SegmentButton active={mode === "type"} onClick={() => setMode("type")} disabled={sending} label="Type keys" />
          <SegmentButton
            active={mode === "clipboard"}
            onClick={() => setMode("clipboard")}
            disabled={sending}
            label="Set VM clipboard"
          />
        </div>
        <button
          type="button"
          data-text-to-vm-send
          onClick={send}
          disabled={!canSend}
          className="mono"
          style={{
            ...bigButton,
            background: canSend ? tokens.accent : tokens.bgCard,
            color: canSend ? tokens.accentInk : tokens.textMuted,
            border: canSend ? "none" : `1px solid ${tokens.borderDivider}`,
            cursor: canSend ? "pointer" : "not-allowed",
          }}
        >
          {sending ? `sending ${progress.sent}/${progress.total}` : mode === "type" ? "Send" : "Set clipboard"}
        </button>
        {mode === "type" && (
          <button
            type="button"
            data-text-to-vm-send-enter
            onClick={() => void typeKeys(true)}
            disabled={!canSend}
            className="mono"
            title="Type the text, then press Enter in the VM"
            style={{
              ...bigButton,
              background: tokens.bgCard,
              color: canSend ? tokens.text : tokens.textMuted,
              border: `1px solid ${canSend ? tokens.borderEmphasis : tokens.borderDivider}`,
              cursor: canSend ? "pointer" : "not-allowed",
            }}
          >
            Send ⏎
          </button>
        )}
        <button
          type="button"
          data-text-to-vm-clear
          onClick={() => {
            setText("");
            setFeedback(null);
            textareaRef.current?.focus();
          }}
          disabled={sending || text.length === 0}
          className="mono"
          style={{ ...bigButton, background: "transparent", color: tokens.textMuted, border: `1px solid ${tokens.borderDivider}` }}
        >
          Clear
        </button>
        <button
          type="button"
          data-text-to-vm-toggle
          onClick={() => setHidden(true)}
          disabled={sending}
          className="mono"
          style={{ ...bigButton, background: "transparent", color: tokens.textMuted, border: `1px solid ${tokens.borderDivider}` }}
        >
          Hide input
        </button>
        {extraActions}
      </div>
    </div>
  );
}

function SegmentButton({
  active,
  onClick,
  disabled,
  label,
}: {
  active: boolean;
  onClick: () => void;
  disabled: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      disabled={disabled}
      className="mono"
      style={{
        flex: 1,
        minHeight: TOUCH_MIN_PX,
        padding: "0 10px",
        fontSize: 13,
        background: active ? tokens.primaryActionBg : "transparent",
        color: active ? tokens.accent : tokens.textMuted,
        border: "none",
        borderRadius: 0,
        cursor: disabled ? "not-allowed" : "pointer",
        fontWeight: active ? 600 : 400,
      }}
    >
      {label}
    </button>
  );
}

const panelStyle: CSSProperties = {
  flexShrink: 0,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  padding: "8px 10px",
  boxSizing: "border-box",
  background: tokens.bgCard,
  borderTop: `1px solid ${tokens.borderDivider}`,
};

export const bigButton: CSSProperties = {
  minHeight: TOUCH_MIN_PX,
  padding: "0 14px",
  fontSize: 14,
  borderRadius: 6,
  cursor: "pointer",
  whiteSpace: "nowrap",
};
