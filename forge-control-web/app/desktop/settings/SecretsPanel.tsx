"use client";

/**
 * SecretsPanel — the SECRETS section of the settings surface.
 *
 * Deliberately NOT a reimplementation. `app/settings/secrets/page.tsx` owns
 * the reveal/dismiss/delete flows and the rule that a revealed value lives in
 * React state only while you look at it; re-typing any of that here would give
 * the OS two secret readers that can drift apart. This panel mounts that page
 * component and nothing else.
 *
 * What it does have to fix is the page's *chrome*, and it fixes it from the
 * outside because that file belongs to another owner this round:
 *
 *   • the page paints itself `min-height: 100dvh` with its own body padding —
 *     inside a surface slot that reads as a page pasted into a panel, which is
 *     the exact "detached page" feeling this round exists to remove;
 *   • it carries a `<Link href="/settings">` back-link. Clicking that inside
 *     the shell would unmount the whole OS to reach a route the surface has
 *     already replaced. The surface's own BackButton is the back-nav here.
 *   • its `<h1>Secrets</h1>` duplicates the section header above it.
 *
 * The override is a scoped stylesheet keyed on `data-settings-embed`, using
 * `!important` because everything it fights is an inline style. Selectors are
 * chosen to be as specific about INTENT as possible (`a[href="/settings"]`,
 * not "the first link"), so if that page is restyled the override either still
 * matches or visibly stops mattering — it cannot silently hide new content.
 */

import { type JSX } from "react";
import SecretsPage from "../../settings/secrets/page";

const EMBED_CSS = `
[data-settings-embed="secrets"] > div {
  min-height: 0 !important;
  padding: 0 !important;
  background: transparent !important;
}
[data-settings-embed="secrets"] > div > div {
  max-width: none !important;
  margin: 0 !important;
}
[data-settings-embed="secrets"] a[href="/settings"] {
  display: none !important;
}
[data-settings-embed="secrets"] h1 {
  display: none !important;
}
`;

export function SecretsPanel(): JSX.Element {
  return (
    <div data-settings-embed="secrets">
      <style>{EMBED_CSS}</style>
      <SecretsPage />
    </div>
  );
}
