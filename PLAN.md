# aios-takeover-clipboard-bridge — plan (round 0)

**Goal.** Provide two buttons in the takeover toolbar ("Paste to VM" and "Copy from VM") in `forge-control-web/app/takeover/[runId]/TakeoverClient.tsx` so Konrad can seamlessly move text between his local machine and the virtual desktop, with honest error handling and zero server routes. Additionally, make VM clipboard synchronization (`autocutsel`) and window manager ergonomics (openbox `menu.xml`) durable in `scripts/research-browser.mjs`.

## Recommendation

Implement a 100% client-side clipboard bridge inside `TakeoverClient.tsx` utilizing the same-origin noVNC iframe DOM, and harden the VM environment in `research-browser.mjs`:

1. **Local to Remote ("Paste to VM")**:
   - Button click reads Konrad's local clipboard via `navigator.clipboard.readText()`.
   - Directly sets value of `#noVNC_clipboard_text` textarea in `iframe.contentDocument`.
   - Dispatches a bubbling `change` event on the textarea, triggering noVNC's `UI.clipboardSend()` -> `UI.rfb.clipboardPasteFrom(text)` without needing access to any unexported ES module globals.
   - Provides clear feedback on success confirming character count: `"Pasted N chars to VM"`.
   - **Honest error handling**: If `readText()` is denied or unsupported (e.g. Firefox or non-secure context), renders a visible small fallback textarea/popover where the user can paste manually and inject into the VM, or displays the exact permission error rather than silently failing.

2. **Remote to Local ("Copy from VM")**:
   - Button click reads `#noVNC_clipboard_text` value from `iframe.contentDocument`.
   - **Empty clipboard guard**: If textarea is empty, displays `"nothing in the VM clipboard yet"` and **never** overwrites Konrad's local clipboard with `""`.
   - If non-empty: writes to local clipboard via `navigator.clipboard.writeText(value)` and confirms character count: `"Copied N chars from VM"`.
   - Handles write permission denials gracefully.

3. **Zero Server Routes Added**:
   - Strictly enforces the invariant that `/api/browser-takeover/` mounts nothing new. All clipboard bridge logic is contained entirely within the client-side component and iframe DOM.

4. **Session Quality & VM Durability**:
   - `autocutsel`: Add to `TAKEOVER_BINARIES` (`/usr/bin/autocutsel`) and require in `assertTakeoverPrereqs()` (exit code 2 if missing). In `ensureTakeover()`, launch two detached instances per display (`-selection CLIPBOARD` and `-selection PRIMARY`), track PIDs in `takeover.json`, and clean up in `teardownTakeover()`.
   - Openbox `menu.xml`: Ship `scripts/config/openbox/menu.xml` in repo and automatically install/sync to `~/.config/openbox/menu.xml` during session startup before Openbox launches.

## What owns state · What dispatches · What fails how · How Konrad sees it

- **State**:
  - Local clipboard: Browser runtime (`navigator.clipboard`).
  - Remote clipboard: X11 selection buffer synced via `autocutsel` <-> `x11vnc` <-> `noVNC_clipboard_text` textarea in iframe.
  - Toolbar state: React state in `TakeoverClient.tsx` (action status, feedback message, fallback prompt).
- **Dispatch**:
  - User click triggers async clipboard operations and DOM events across parent and iframe.
- **Failures & Defenses**:
  - Unloaded iframe / missing DOM: guarded with null checks on `contentDocument` and `#noVNC_clipboard_text`, displaying `"Viewer not ready"`.
  - Browser permission denial / insecure context / Firefox: caught in try/catch, surfaces explicit error message and renders fallback paste box.
  - Empty remote buffer: checks string length, reports `"nothing in the VM clipboard yet"`, leaves local clipboard intact.
  - Missing `autocutsel` binary: `research-browser.mjs` exits code 2 naming missing binary.
- **Visibility**:
  - Character count confirmations appear inline in the toolbar upon successful transfers.
  - Failures and fallback prompts appear directly in the toolbar.
  - Verification screenshots captured in real browser harness and read back into chat.

## Rejected Alternatives

- **Server-side clipboard proxy endpoint**: Rejected — violates security policy on `/api/browser-takeover/` and adds unnecessary server attack surface.
- **Accessing `window.UI`**: Rejected — noVNC `app/ui.js` is an ES module (`export default UI`) and does not attach `UI` to `window`.
- **Automatic background polling of clipboard**: Rejected — triggers continuous browser permission prompts and races user gestures.
- **Overwriting local clipboard with empty string**: Rejected — corrupts user's existing clipboard contents.
- **`autocutsel -fork`**: Rejected — breaks supervisor PID tracking and cleanup in `research-browser.mjs`.

## Task Graph

```
T1 builder (standard, main) ──┐
  takeover-ui: clipboard      │
  bridge in TakeoverClient    ├─► T3 builder (junior, main) ─────► T4 reviewer (standard, main)
                              │     harness: E2E automated         review: diff review, gates,
T2 builder (standard, main) ──┘     verification & screenshots     and visual evidence check
  session-quality: autocutsel
  & openbox menu.xml
```

1. **T1 (Builder, tier: standard, workstream: main)**:
   - `write_set`: `["forge-control-web/app/takeover/[runId]/TakeoverClient.tsx"]`
   - Implement "Paste to VM" and "Copy from VM" toolbar buttons, same-origin iframe communication, empty check guards, and honest error fallback UI.
2. **T2 (Builder, tier: standard, workstream: main)**:
   - `write_set`: `["scripts/research-browser.mjs", "scripts/config/openbox/menu.xml"]`
   - Add `autocutsel` dual-selection startup, lifecycle tracking, exit 2 prereq check, and ship/install `menu.xml`.
3. **T3 (Builder, tier: junior, workstream: main, depends_on: [T1, T2])**:
   - `write_set`: `["scripts/checks/check-takeover-clipboard-e2e.ts"]`
   - Implement automated Playwright E2E harness covering Paste, Copy, empty guard, permission fallback, and capture/read back screenshots.
4. **T4 (Reviewer, tier: standard, workstream: main, depends_on: [T1, T2, T3])**:
   - Review entire diff against requirements, zero-server-route invariant, typecheck, gates, and evidence.
