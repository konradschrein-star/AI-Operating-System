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
  // Run on everything except Next's static assets — and `public/fonts`, which is
  // static in every sense that matters but lives outside `_next/`. Without the
  // `fonts` alternative below, `GET /fonts/inter-variable-latin.woff2` answers
  // 307 -> /signin (measured). The authenticated app is unaffected, because a
  // logged-in request passes the wall anyway; the single casualty is the SIGN-IN
  // PAGE, which uses `.mono` and would fall back to `ui-monospace` for the one
  // page a user sees before they have a session.
  //
  // `fonts/` WITH THE SLASH, deliberately. A bare `fonts` is a prefix, not a
  // directory: it would also exclude `/fontsecret-probe` — measured, middleware
  // did not run on it — quietly widening the public surface to every future route
  // whose name happens to start with those five letters.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|fonts/).*)"],
};
