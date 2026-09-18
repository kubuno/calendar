-- 000011_room_release.up.sql
--
-- When a meeting empties out, the room it was holding is given back.
--
-- ## Why a stamp and not just a status
--
-- A released room carries `status = 'declined'`, exactly like a room that
-- refused because it was already booked — the two are indistinguishable from the
-- status alone. This stamp is what separates them, and it is the only thing that
-- makes "hours released" countable later: without it the figure would include
-- every clash, and an administrator would read a room-release rate that measures
-- double bookings instead.
--
-- NULL therefore means "not released", which is the case for every row that
-- exists today and for every human attendee for ever — a person is not released,
-- they decline.
ALTER TABLE calendar.attendees
    ADD COLUMN released_at TIMESTAMPTZ;

-- The listing behind the figure: released rooms over a period. Partial, because
-- the overwhelming majority of rows will never carry the stamp.
CREATE INDEX idx_calendar_att_released
    ON calendar.attendees (released_at)
    WHERE released_at IS NOT NULL;
