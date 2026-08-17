"use client";

/**
 * IntegrationsPanel — the INTEGRATIONS section of the settings surface.
 *
 * STUB, and a contract: round 1352 fills this file in and edits nothing else.
 * `SettingsSurface` already imports and mounts it, so whoever lands the real
 * integration registry (Google Workspace, GitHub, Telegram, MCP servers)
 * touches this file only.
 *
 * Contract — do not change the signature:
 *   export function IntegrationsPanel(): JSX.Element
 */

import { type JSX } from "react";
import { tokens } from "../../tokens";

export function IntegrationsPanel(): JSX.Element {
  return (
    <div
      data-integrations-panel
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
      loading integrations…
    </div>
  );
}
