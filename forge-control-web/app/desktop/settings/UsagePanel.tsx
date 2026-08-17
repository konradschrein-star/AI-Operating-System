"use client";

/**
 * UsagePanel — the USAGE section of the settings surface.
 *
 * STUB, and a contract: round 1352 fills this file in and edits nothing else.
 * `SettingsSurface` already imports and mounts it, so the builder who lands
 * the real token/spend readout never has to touch the surface, the rail, or
 * the /settings route.
 *
 * Contract — do not change the signature:
 *   export function UsagePanel(): JSX.Element
 *
 * Settings is the one place in this UI where money numbers are allowed, and
 * this panel is where they belong. Until they exist the panel says it is
 * waiting rather than showing a zero: a €0.00 that is really "not loaded yet"
 * is the same class of lie the Live panel spent three rounds removing.
 */

import { type JSX } from "react";
import { tokens } from "../../tokens";

export function UsagePanel(): JSX.Element {
  return (
    <div
      data-usage-panel
      className="mono"
      style={{
        background: tokens.bgCard,
        border: `1px dashed ${tokens.border}`,
        borderRadius: 10,
        padding: 26,
        fontSize: 12,
        color: tokens.textFaint,
        textAlign: "center",
      }}
    >
      loading usage…
    </div>
  );
}
