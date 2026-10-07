-- 000011_room_release.down.sql
--
-- The rooms stay declined; only the reason they were declined is forgotten.
DROP INDEX IF EXISTS calendar.idx_calendar_att_released;

ALTER TABLE calendar.attendees
    DROP COLUMN IF EXISTS released_at;
