-- 000002_calendar_attendees.up.sql

-- Participants aux événements
CREATE TABLE calendar.attendees (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id        UUID NOT NULL REFERENCES calendar.events(id) ON DELETE CASCADE,
    user_id         UUID,                                      -- NULL si externe
    email           VARCHAR(500) NOT NULL,
    display_name    VARCHAR(255),
    status          VARCHAR(20) NOT NULL DEFAULT 'needs-action'
                        CHECK (status IN ('needs-action', 'accepted', 'declined', 'tentative')),
    is_organizer    BOOLEAN NOT NULL DEFAULT FALSE,
    rsvp_token      VARCHAR(64) UNIQUE,                        -- pour RSVP par lien email
    rsvp_expires_at TIMESTAMPTZ,
    invited_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    responded_at    TIMESTAMPTZ,
    comment         TEXT,
    UNIQUE (event_id, email)
);

CREATE INDEX idx_calendar_att_event ON calendar.attendees(event_id);
CREATE INDEX idx_calendar_att_user  ON calendar.attendees(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_calendar_att_token ON calendar.attendees(rsvp_token) WHERE rsvp_token IS NOT NULL;
