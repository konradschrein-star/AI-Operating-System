# Round 0 · R1 — keysym / module-trick measurement (pointer)

The full report, with commands, numbers, screenshots and sources, is the task's named
deliverable: [`docs/plan/aios-takeover-usable/research-keysym.md`](../plan/aios-takeover-usable/research-keysym.md)
(PLAN.md line 174 names that path; this file exists so the round-0 research index resolves).

Headline numbers (2026-08-26, noVNC 1.3.0 / x11vnc 0.9.16 / Chrome 148 on Xvfb `:97`):

- Module trick `import UI from './app/ui.js'` → `window.__forgeNoVNC` returns the live
  instance both on the page and from a parent frame into a same-origin iframe
  (`rfb` is an `RFB`, `connected === true`, re-import `===` same object).
- No `noVNC_disconnected` class exists; watch for **removal** of `noVNC_connected`. A
  parent-owned MutationObserver fired 27 ms after the socket was killed with `ss -K`;
  the `disconnect` event reported `clean: true`.
- `UI.rfb.sendKey(keysym, null)` round-trips byte-exact at **0 ms** inter-key delay:
  5/5 for `Pässwörd ßÄÖÜ €` and 5/5 for a 300-char German/€ string, at every delay in
  {0,4,8,16,32}; 3/3 for 1000 and 3000-char bursts; `🙂` works as `0x0101f642`.
- Hazard: the VM Chrome's keyboard focus starts in the **omnibox**; Return there
  submitted the text to Google search. Never append Enter implicitly.
- Harness defects: `assignDisplay` ignores foreign `/tmp/.X<n>-lock` (profile names
  hashing to `:99` cannot open); hermes Playwright's bundled headless shell is missing —
  use `/usr/bin/google-chrome-stable`.

Sources: see the full report's `Sources` section.
