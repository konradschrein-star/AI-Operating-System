/**
 * linkage-dryrun.mts — what phase 300's detail resolver WOULD attribute to a
 * chat, without touching the database.
 *
 * Round 403's brief offers an optional step: open this project's own chat
 * `bfd1283a…` once, so the detail resolver backfills `origin_chat_id` into the
 * real `projects` row and the LIVE project also shows an `x/y tasks` badge in
 * the rail. That is a real metadata write to Konrad's production database, so
 * it was checked BEFORE being done rather than after — and the check says the
 * write would never have happened: the bounded scan finds zero candidates in
 * that chat.
 *
 * Only `scanThreadForProjectIds` is imported — a pure function, no pool, no
 * write path. The thread arrives on stdin from psql.
 *
 *   set -a; . /opt/ai-os/.secrets/forge-control.env; set +a
 *   psql "$DATABASE_URL" -tAc "select thread from runs where id='<chat-uuid>';" \
 *     | forge-control/node_modules/.bin/tsx docs/plan/artifacts/phase400/linkage-dryrun.mts
 *
 * A non-empty candidate list is NOT yet a backfill: the resolver then keeps
 * only uuids that are real `projects` rows (bound 4) and refuses to write when
 * more than one survives. Both filters are re-checked by hand in README.md.
 */
import { scanThreadForProjectIds } from "../../../../forge-control/src/routes/chat-linkage.ts";

const raw = await new Promise<string>((resolve, reject) => {
  let buf = "";
  process.stdin.on("data", (c) => (buf += c));
  process.stdin.on("end", () => resolve(buf));
  process.stdin.on("error", reject);
});

const thread: unknown = JSON.parse(raw);
if (!Array.isArray(thread)) throw new Error("stdin is not a thread array");
console.log("thread entries:", thread.length);
console.log("scan candidates:", scanThreadForProjectIds(thread as never));
