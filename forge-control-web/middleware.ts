import { auth } from "./auth";
import { NextResponse } from "next/server";

export default auth((req) => {
  const isAuthed = !!req.auth;
  const url = req.nextUrl;
  const isPublic =
    url.pathname.startsWith("/api/auth") ||
    url.pathname === "/signin" ||
    url.pathname === "/favicon.ico" ||
    url.pathname.startsWith("/_next/");

  if (!isPublic && !isAuthed) {
    return NextResponse.redirect(new URL("/signin", url));
  }
  return NextResponse.next();
});

export const config = {
  // Run on everything except Next's static assets.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
