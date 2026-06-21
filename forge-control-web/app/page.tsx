import { headers } from "next/headers";
import { MobileApp } from "./MobileApp";
import { DesktopApp } from "./desktop/DesktopApp";

// Pick the UI from the User-Agent so the root URL just works on both phone
// and PC. Explicit `/desktop` and `/mobile` (TODO) routes stay as overrides.
export default async function Page() {
  const h = await headers();
  const ua = (h.get("user-agent") ?? "").toLowerCase();
  const isMobile =
    /iphone|ipad|ipod|android|mobile|silk|kindle|blackberry|opera mini/.test(
      ua,
    );
  return isMobile ? <MobileApp /> : <DesktopApp />;
}
