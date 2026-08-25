-- 0049 — importance goes from four levels to Konrad's six.
--
-- His Notion had six (Ultra Important → Insignificant) and he called that part
-- "quite ingenious"; the OS shipped four, so `!ultra` and `!high` collided and
-- the distinction he actually used was invisible.
--
-- OLD (0..3)                NEW (0..5)
--   3 critical               5 ultra important
--   2 high                   4 really important
--   1 normal                 3 important
--   0 low                    2 normal
--                            1 secondary
--                            0 insignificant
--
-- The remap below is ORDER-SENSITIVE and runs high-to-low deliberately. Going
-- the other way, 0→? then 1→? would re-read rows this statement had already
-- moved and cascade every task to the top of the scale.
--
-- 2 is the new default because it is "normal" — the old default was also 2 but
-- meant "high", so leaving it alone would silently promote every future task.

UPDATE day_tasks SET importance = 5 WHERE importance = 3;
UPDATE day_tasks SET importance = 4 WHERE importance = 2;
UPDATE day_tasks SET importance = 3 WHERE importance = 1;
UPDATE day_tasks SET importance = 2 WHERE importance = 0;

ALTER TABLE day_tasks ALTER COLUMN importance SET DEFAULT 2;

-- A CHECK now, because there was none before and that is why the scale could
-- drift silently in the first place.
ALTER TABLE day_tasks DROP CONSTRAINT IF EXISTS day_tasks_importance_range;
ALTER TABLE day_tasks ADD CONSTRAINT day_tasks_importance_range
  CHECK (importance BETWEEN 0 AND 5);

COMMENT ON COLUMN day_tasks.importance IS
  '0 insignificant / 1 secondary / 2 normal / 3 important / 4 really important / 5 ultra important';
