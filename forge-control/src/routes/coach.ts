/**
 * Coach metrics routes (v2.2).
 *
 *   POST /api/coach/metrics  {day?, committed, completed, notes?}
 *     — the evening coach run curls this after counting the daily note's
 *       checkboxes. day defaults to today in REMINDER_TZ.
 *   GET  /api/coach/metrics  → {days: [...], streak}
 *     — Today surface + future coach runs read the accountability history.
 */

import { Hono } from "hono";
import { upsertCoachDay, listCoachDays, currentStreak } from "../db/coach.ts";

const r = new Hono();

function todayInTz(): string {
  const tz = process.env.REMINDER_TZ ?? "Europe/Berlin";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts; // en-CA gives YYYY-MM-DD
}

r.post("/metrics", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    day?: string;
    committed?: number;
    completed?: number;
    notes?: string;
  };
  const committed = Number(body.committed);
  const completed = Number(body.completed);
  if (!Number.isInteger(committed) || !Number.isInteger(completed)) {
    return c.json({ error: "committed and completed must be integers" }, 400);
  }
  const day = body.day && /^\d{4}-\d{2}-\d{2}$/.test(body.day)
    ? body.day
    : todayInTz();
  const row = await upsertCoachDay({
    day,
    committed,
    completed,
    notes: body.notes,
  });
  return c.json({ ok: true, day: row, streak: await currentStreak() });
});

r.get("/metrics", async (c) => {
  const days = await listCoachDays(30);
  return c.json({ days, streak: await currentStreak() });
});

export default r;
