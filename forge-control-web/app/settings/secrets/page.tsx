"use client";

/**
 * /settings/secrets — standalone page route for secret store management.
 */

import Link from "next/link";
import { tokens } from "../../tokens";
import { SecretsPanel } from "../../desktop/settings/SecretsPanel";

export default function SecretsPage() {
  return (
    <div
      style={{
        minHeight: "100dvh",
        background: tokens.bgBody,
        color: tokens.text,
        padding: "28px 32px 64px",
      }}
    >
      <div style={{ maxWidth: 940, margin: "0 auto" }}>
        <div style={{ marginBottom: 18 }}>
          <Link
            href="/settings"
            className="mono"
            style={{
              color: tokens.textMuted,
              textDecoration: "none",
              fontSize: 12,
            }}
          >
            ← BACK TO SETTINGS
          </Link>
        </div>

        <SecretsPanel />
      </div>
    </div>
  );
}

