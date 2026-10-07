-- 000010_room_attendees.down.sql
--
-- Rooms stop being attendees. Their rows go first: `email` cannot be made NOT
-- NULL again while they hold a NULL there, and they mean nothing without the
-- column that identified them.
DELETE FROM calendar.attendees WHERE resource_id IS NOT NULL;

DROP INDEX IF EXISTS calendar.idx_calendar_att_resource;
DROP INDEX IF EXISTS calendar.idx_calendar_att_event_resource;

ALTER TABLE calendar.attendees
    DROP CONSTRAINT IF EXISTS attendee_person_xor_resource;

ALTER TABLE calendar.attendees
    ALTER COLUMN email SET NOT NULL;

ALTER TABLE calendar.attendees
    DROP COLUMN IF EXISTS resource_id;
