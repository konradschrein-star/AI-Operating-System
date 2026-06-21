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
