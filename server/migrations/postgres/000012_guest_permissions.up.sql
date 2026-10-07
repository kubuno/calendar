-- What the organiser lets the guests do, and which of them must be there.
--
-- Until now an event had exactly one person who could act on it — its owner —
-- and a guest was an address that received an invitation. That is only the
-- simplest of the arrangements people actually make: a meeting whose notes
-- anyone may correct, a gathering whose guests bring other guests, a list of
-- names some of the invited should not see, and the person whose presence is
-- welcome but not required.
--
-- The three permissions sit on the EVENT because they are one decision about
-- one gathering; the fourth sits on the attendee because it is a statement
-- about that person. Defaults reproduce the documented behaviour of the field:
-- guests may invite and may see each other, and may not rewrite the event.
ALTER TABLE calendar.events
  ADD COLUMN IF NOT EXISTS guests_can_modify     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS guests_can_invite     BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS guests_can_see_guests BOOLEAN NOT NULL DEFAULT TRUE;

-- "Your presence is welcome, it is not required." A distinct thing from a
-- refusal: an optional guest who does not come has not declined anything, and
-- an organiser reading the replies should not have to guess which absences
-- matter.
ALTER TABLE calendar.attendees
  ADD COLUMN IF NOT EXISTS optional BOOLEAN NOT NULL DEFAULT FALSE;
