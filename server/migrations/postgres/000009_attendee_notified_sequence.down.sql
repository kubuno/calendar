-- 000009_attendee_notified_sequence.down.sql
ALTER TABLE calendar.attendees
    DROP COLUMN IF EXISTS last_notified_sequence;
