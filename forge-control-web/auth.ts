import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

/**
 * Single-user auth for forge-control-web.
 *
 * Allowlist is set via AUTH_ALLOWLIST (comma-separated GitHub usernames or
 * emails). Only Konrad gets in; everything else is rejected at signIn.
 */

const allowlist = (process.env.AUTH_ALLOWLIST ?? "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
      /**
       * REQUIRED SINCE GITHUB ENABLED RFC 9207 — added 2026-08-25, after
       * Konrad could not sign in on his phone and got "auth error:
       * configuration".
       *
       * GitHub now returns an `iss` (issuer identification) parameter on the
       * OAuth callback. oauth4webapi inside @auth/core validates it against
       * this provider's expected issuer, which for a plain OAuth2 provider
       * defaults to the placeholder "https://authjs.dev" — so every fresh
       * sign-in died with:
       *
       *   [auth][cause]: unexpected "iss" (issuer) response parameter value
       *   [auth][details]: {"expected":"https://authjs.dev","provider":"github"}
       *
       * Auth.js surfaces that CallbackRouteError to the user as the opaque
       * `Configuration` error, which is why the symptom named no cause.
       *
       * Existing sessions were unaffected (the cookie was already minted), so
       * this looked like "only my phone is broken" while it was in fact every
       * new sign-in on every device.
       *
       * The value is GitHub's own `iss`, not a guess. Do not "tidy" this to
       * "https://github.com" — the issuer GitHub identifies itself with is the
       * OAuth path, and a near-miss fails exactly the same way. This does NOT
       * trigger OIDC discovery: the GitHub provider declares explicit
       * authorization/token/userinfo endpoints, so `issuer` is only used as
       * the expected value for this check.
       */
      issuer: "https://github.com/login/oauth",
    }),
  ],
  callbacks: {
    async signIn({ profile }) {
      if (allowlist.length === 0) return true; // dev escape: empty allowlist = open
      const login = (
        (profile as { login?: string } | null)?.login ?? ""
      ).toLowerCase();
      const email = (profile?.email ?? "").toLowerCase();
      return allowlist.includes(login) || allowlist.includes(email);
    },
  },
  pages: {
    signIn: "/signin",
    error: "/signin",
  },
});
