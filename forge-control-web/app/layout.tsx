import "./globals.css";
import "./v2.css";
// Defines every --fg-* custom property for both palettes. app/tokens.ts is
// nothing but var(--fg-*) references, so WITHOUT THIS IMPORT the entire UI
// renders colourless. Imported after v2.css on purpose: theme.css re-declares
// v2's "not theme dependent" surface scale for light mode and must win the
// cascade (it also scopes light under html[data-theme] for belt-and-braces
// specificity, so an import reshuffle can't silently break it).
import "./theme.css";
import type { Metadata, Viewport } from "next";
import { Providers } from "./Providers";

export const metadata: Metadata = {
  title: "forge",
  description: "Personal AI OS Console",
  applicationName: "forge",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "forge",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#000",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <head>
        {/* NO FONT <link>s. All three families (Inter, JetBrains Mono, Material
            Symbols Outlined) are self-hosted from public/fonts and declared in
            globals.css — see the @font-face block at the top of that file for
            the measurement and the reasoning.

            The two fonts.googleapis.com stylesheets AND their two preconnect
            hints were removed together, deliberately. A leftover render-blocking
            stylesheet that never resolves is browser-harness.md §5 Failure 4:
            DOMContentLoaded never fires, page.goto times out, and a live surface
            is reported dead. A preconnect to a host nothing requests is a DNS +
            TLS handshake for nothing. */}
        {/* Apply the stored theme BEFORE first paint — otherwise a light-mode
            user eats a black flash on every navigation. Inline and blocking on
            purpose: it's three lines and must run before the body renders. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem('forge.theme');if(t==='light'||t==='dark'){document.documentElement.dataset.theme=t;}}catch(e){}})();`,
          }}
        />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
