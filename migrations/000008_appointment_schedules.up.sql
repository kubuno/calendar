-- 000008_appointment_schedules.up.sql
--
-- Bookable appointment schedules: the owner publishes their availability
-- through a booking page; invitees pick a free
-- slot on a public page and a booking is recorded (and an event created on the
-- owner's calendar). Distinct from meeting polls (000003), which are Doodle-style
-- "propose slots, everyone votes".

CREATE TABLE calendar.appointment_schedules (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id           UUID NOT NULL,
    calendar_id        UUID NOT NULL REFERENCES calendar.calendars(id) ON DELETE CASCADE,
    public_token       VARCHAR(64) UNIQUE NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),

    title              VARCHAR(500) NOT NULL DEFAULT '',
    description        TEXT,                                   -- rich text (HTML) shown on the booking page
    color              VARCHAR(20),

    duration_minutes   INTEGER NOT NULL DEFAULT 60 CHECK (duration_minutes > 0),
    buffer_minutes     INTEGER CHECK (buffer_minutes IS NULL OR buffer_minutes >= 0),  -- padding between appointments
    max_per_day        INTEGER CHECK (max_per_day IS NULL OR max_per_day > 0),          -- cap of bookings per day
    timezone           VARCHAR(64) NOT NULL DEFAULT 'UTC',

    -- Scheduling window: how far ahead / how little notice bookings are allowed.
    window_type        VARCHAR(20) NOT NULL DEFAULT 'rolling'
                           CHECK (window_type IN ('rolling', 'fixed')),
    window_max_days    INTEGER CHECK (window_max_days IS NULL OR window_max_days > 0),   -- rolling: bookable up to N days ahead
    window_min_hours   INTEGER CHECK (window_min_hours IS NULL OR window_min_hours >= 0),-- min notice before an appointment
    window_start_date  DATE,                                   -- fixed window bounds
    window_end_date    DATE,

    -- Location / conference. 'video' means the host provides a link in
    -- location_details; we never generate a third-party meeting link.
    location_type      VARCHAR(20) NOT NULL DEFAULT 'none'
                           CHECK (location_type IN ('none', 'in_person', 'phone', 'video')),
    location_details   TEXT,

    guests_can_invite  BOOLEAN NOT NULL DEFAULT TRUE,          -- invitees may add other guests

    -- Snapshot of the host's identity for the public page (modules can't read
    -- core.users; the frontend passes the current display name / avatar).
    host_name          VARCHAR(255),
    host_avatar_url    VARCHAR(1000),

    -- Custom booking-form fields beyond the built-in first/last name + email.
    -- Array of { id, label, type, required }.
    form_fields        JSONB NOT NULL DEFAULT '[]',

    -- Confirmations & reminders. calendar_invite is always on (kept for parity);
    -- email_reminders is an array of minutes-before values.
    calendar_invite    BOOLEAN NOT NULL DEFAULT TRUE,
    email_reminders    JSONB NOT NULL DEFAULT '[1440]',        -- default: 1 day before

    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_calendar_as_owner ON calendar.appointment_schedules(owner_id);
CREATE INDEX idx_calendar_as_token ON calendar.appointment_schedules(public_token);
CREATE INDEX idx_calendar_as_calendar ON calendar.appointment_schedules(calendar_id);

-- Availability rules. Either a weekly rule (weekday set, specific_date NULL) or
-- a date-specific override (specific_date set, weekday NULL). Times are minutes
-- from midnight in the schedule's timezone. weekday: 0 = Monday … 6 = Sunday.
CREATE TABLE calendar.appointment_availability (
    id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    schedule_id    UUID NOT NULL REFERENCES calendar.appointment_schedules(id) ON DELETE CASCADE,
    weekday        SMALLINT CHECK (weekday IS NULL OR (weekday BETWEEN 0 AND 6)),
    specific_date  DATE,
    start_minute   INTEGER NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
    end_minute     INTEGER NOT NULL CHECK (end_minute > 0 AND end_minute <= 1440),
    CONSTRAINT appt_avail_end_after_start CHECK (end_minute > start_minute),
    CONSTRAINT appt_avail_kind CHECK ((weekday IS NULL) <> (specific_date IS NULL))
);

CREATE INDEX idx_calendar_aa_schedule ON calendar.appointment_availability(schedule_id);

-- Recorded bookings. A confirmed booking usually has a linked event on the
-- owner's calendar (event_id); cancelling a booking sets status='cancelled'.
CREATE TABLE calendar.appointment_bookings (
    id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    schedule_id   UUID NOT NULL REFERENCES calendar.appointment_schedules(id) ON DELETE CASCADE,
    starts_at     TIMESTAMPTZ NOT NULL,
    ends_at       TIMESTAMPTZ NOT NULL,
    first_name    VARCHAR(255) NOT NULL,
    last_name     VARCHAR(255),
    email         VARCHAR(500) NOT NULL,
    answers       JSONB NOT NULL DEFAULT '{}',                -- custom form-field answers by field id
    note          TEXT,
    event_id      UUID REFERENCES calendar.events(id) ON DELETE SET NULL,
    status        VARCHAR(20) NOT NULL DEFAULT 'confirmed'
                      CHECK (status IN ('confirmed', 'cancelled')),
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT appt_booking_ends_after_starts CHECK (ends_at > starts_at)
);

CREATE INDEX idx_calendar_ab_schedule ON calendar.appointment_bookings(schedule_id);
CREATE INDEX idx_calendar_ab_starts   ON calendar.appointment_bookings(starts_at);

-- updated_at trigger (reuse the pattern from meeting_polls).
CREATE OR REPLACE FUNCTION calendar.set_as_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER appointment_schedules_updated_at
    BEFORE UPDATE ON calendar.appointment_schedules
    FOR EACH ROW EXECUTE FUNCTION calendar.set_as_updated_at();
