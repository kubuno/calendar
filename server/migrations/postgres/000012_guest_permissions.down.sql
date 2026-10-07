ALTER TABLE calendar.attendees DROP COLUMN IF EXISTS optional;
ALTER TABLE calendar.events
  DROP COLUMN IF EXISTS guests_can_see_guests,
  DROP COLUMN IF EXISTS guests_can_invite,
  DROP COLUMN IF EXISTS guests_can_modify;
