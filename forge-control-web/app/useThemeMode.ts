"use client";

import { useEffect, useState } from "react";
import { type ThemeMode } from "./tokens";

/**
 * The current theme, read from the one place that actually holds it.
 *
 * `applyTheme()` writes `document.documentElement.dataset.theme`, the pre-paint
 * script in `layout.tsx` writes the same attribute before React exists, and
 * `theme.css` keys its whole light palette off `html[data-theme="light"]`. So
 * the attribute IS the theme — there is no context, no store, no prop chain.
 *
 * Components that resolve colours through `tokens.*` never need this: the
 * cascade re-resolves `var(--fg-*)` for them on its own. This hook is for the
 * handful that hand a *value* to something outside the cascade — today that is
 * `<Excalidraw theme={…}>`, which paints its own canvas and cannot see CSS
 * custom properties. Before this existed, `CanvasPane` passed the literal
 * `"dark"` and the drawing surface stayed black inside a light console
 * (phase 800 round 804 §5.5, `phase800-canvas-light.png`).
 *
 * A `MutationObserver` rather than a one-shot read, because the toggle flips the
 * attribute on a live page: the editor has to follow a theme switch that
 * happens *while the canvas is open*, without a remount.
 *
 * Initial state is `"dark"` deliberately — that is what `:root` serves and what
 * the server rendered, so first paint agrees and hydration does not warn. The
 * effect corrects it on mount for a client whose stored theme is light.
 */
export function useThemeMode(): ThemeMode {
  const [mode, setMode] = useState<ThemeMode>("dark");

  useEffect(() => {
    const read = (): ThemeMode =>
      document.documentElement.dataset.theme === "light" ? "light" : "dark";

    setMode(read());

    const observer = new MutationObserver(() => setMode(read()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);

  return mode;
}
