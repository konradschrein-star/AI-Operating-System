-- 0027: reminders — quick-capture reminders delivered into inbox_items.
-- Created by /remind slash command, mobile Capture tab, or the CC executor.
-- Delivery: executor reminderTick() flips due 'pending' rows to 'delivered'
-- and mirrors them into inbox_items (external_id 'reminder:<id>:<due_iso>').
-- Recurring rows ('daily'|'weekly') advance due_at instead of terminating.

CREATE TABLE IF NOT EXISTS reminders (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  text         text NOT NULL,
  due_at       timestamptz NOT NULL,
  recur        text CHECK (recur IN ('daily', 'weekly')),
  status       text NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending', 'delivered', 'dismissed')),
  source       text NOT NULL DEFAULT 'chat',
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);

CREATE INDEX IF NOT EXISTS reminders_due_idx
  ON reminders (due_at)
  WHERE status = 'pending';
