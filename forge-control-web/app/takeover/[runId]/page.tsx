/**
 * /takeover/<runId> — the reminder's landing page.
 *
 * Exists because /desktop is a single client-state route with no query deep
 * links (fleet memory: desktop-is-one-route-no-query-deeplinks), so a phone
 * notification about a login wall has nowhere else to point. Sits behind
 * middleware.ts like every other route — the socket it eventually opens
 * carries its own signed ticket, but the mint request that produces that
 * ticket is same-origin and still needs Konrad's session cookie.
 */

import { TakeoverClient } from "./TakeoverClient";

export default async function TakeoverPage({
  params,
}: {
  params: Promise<{ runId: string }>;
}) {
  const { runId } = await params;
  return <TakeoverClient runId={runId} />;
}
