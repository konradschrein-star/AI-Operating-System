"use client";

/**
 * /settings — the URL, kept alive as a thin wrapper.
 *
 * Round 1350 moved settings INTO the shell: the rail no longer navigates here,
 * it opens `app/desktop/settings/SettingsSurface.tsx` in the middle column
 * with the OS still standing around it. Konrad's complaint was precise —
 * losing the whole application to read an account's health is why the old
 * interface "seems a bit weird".
 *
 * The route survives anyway, because a bookmark, a link in a note and a
 * deep-link from Telegram all still point at it, and a 404 is a worse answer
 * than a page. What it is NOT any more is a second implementation: the body
 * below is `AccountsPanel`, the exact component the surface mounts. There is
 * one account registry in this app and both entry points render it.
 */

import Link from "next/link";
import { tokens } from "../tokens";
import { AccountsPanel } from "../desktop/settings/AccountsPanel";

export default function SettingsPage() {
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
        <Link
          href="/"
          style={{
            color: tokens.textMuted,
            textDecoration: "none",
            fontSize: 12.5,
          }}
          className="mono"
        >
          ← BACK TO OS
        </Link>

        <h1 style={{ fontSize: 26, margin: "14px 0 4px", fontWeight: 600 }}>
          Settings
        </h1>
        <div style={{ color: tokens.textMuted, fontSize: 13.5, marginBottom: 6 }}>
          Claude accounts, health and failover policy.
        </div>
        {/* Say where the real thing lives. Someone who landed on this URL from
            an old bookmark should learn, once, that settings is part of the OS
            now — not discover it by accident three rounds later. */}
        <div className="mono" style={{ color: tokens.textFaint, fontSize: 11.5, marginBottom: 14 }}>
          this page also lives inside the OS — rail › SETTINGS, shell intact.
        </div>

        {/* Sub-page rail. Every real /settings/* route lives here — reveal
            secrets, etc. Kept as a plain link row rather than tabs so each
            sub-page keeps its own URL (bookmarkable, backable). */}
        <div style={{ display: "flex", gap: 8, marginBottom: 26, flexWrap: "wrap" }}>
          <Link
            href="/settings/secrets"
            className="mono"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: tokens.bgCard,
              border: `1px solid ${tokens.border}`,
              borderRadius: 8,
              padding: "8px 12px",
              color: tokens.textLabel,
              textDecoration: "none",
              fontSize: 12.5,
            }}
          >
            <span style={{ color: tokens.accent }}>›</span>
            SECRETS — reveal stored credentials
          </Link>
        </div>

        <AccountsPanel />
      </div>
    </div>
  );
}
