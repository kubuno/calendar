-- 000010_room_attendees.up.sql
--
-- A room can now be invited to an event, exactly as a person is.
--
-- ## Why an attendee rather than a column on the event
--
-- Because a room answers. It accepts a meeting or it declines one — when it is
-- already taken, when the meeting outgrows its capacity — and that answer is the
-- same `status` a person carries. Modelling the room as a second kind of
-- attendee gives that for free, keeps one meaning of "who is expected here", and
-- lets an event hold several rooms (two sites joined by video) without a second
-- table. A `room_id` column on `calendar.events` would have needed its own
-- status, its own response time, and would still have stopped at one room.
--
-- ## The room lives in the CORE, not here
--
-- `resource_id` points at `core.resources`, published read-only to modules on
-- `/internal/directory/resources`. Deliberately NO foreign key: the directory is
-- another schema owned by another component, and a module that constrained it
-- would be a module deciding what the organisation contains. A room removed from
-- the directory therefore leaves rows behind — read as an unknown room rather
-- than crashing a listing, the same way a deleted account does elsewhere.
ALTER TABLE calendar.attendees
    ADD COLUMN resource_id UUID;

-- A room has no mailbox. `email` was the identity of an attendee; it now
-- identifies only the human ones.
ALTER TABLE calendar.attendees
    ALTER COLUMN email DROP NOT NULL;

-- Exactly one of the two identities, never both and never neither: an attendee
-- with no e-mail and no room is a row nothing can address, and one with both
-- would be two attendees pretending to be one.
ALTER TABLE calendar.attendees
    ADD CONSTRAINT attendee_person_xor_resource
    CHECK ((resource_id IS NULL) <> (email IS NULL));

-- The same room cannot be invited twice to one event. The pre-existing
-- UNIQUE (event_id, email) keeps doing that job for people, and tolerates the
-- NULL e-mails rooms now carry — Postgres does not compare NULLs as equal.
CREATE UNIQUE INDEX idx_calendar_att_event_resource
    ON calendar.attendees (event_id, resource_id)
    WHERE resource_id IS NOT NULL;

-- The question asked on every booking: "is this room taken between X and Y?".
-- Answered by walking this index into `calendar.events` rather than scanning
-- every attendee of every event.
CREATE INDEX idx_calendar_att_resource
    ON calendar.attendees (resource_id)
    WHERE resource_id IS NOT NULL;
