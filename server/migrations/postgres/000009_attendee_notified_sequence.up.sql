-- 000009_attendee_notified_sequence.up.sql
--
-- Tracks the event SEQUENCE at which each attendee was last notified (the
-- invitation e-mail the Mail module sent on our behalf). An RSVP reply carries
-- the sequence of the invitation it answers; a reply whose sequence is older
-- than the last one we notified is a stale answer to a superseded invitation and
-- is dropped rather than applied.
ALTER TABLE calendar.attendees
    ADD COLUMN last_notified_sequence INT;
