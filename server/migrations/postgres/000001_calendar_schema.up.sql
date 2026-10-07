-- 000001_calendar_schema.up.sql

CREATE SCHEMA IF NOT EXISTS calendar;

-- Calendriers
CREATE TABLE calendar.calendars (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id     UUID NOT NULL,                                -- core.users.id (pas de FK cross-schéma)
    name         VARCHAR(255) NOT NULL,
    description  TEXT,
    color        VARCHAR(7) NOT NULL DEFAULT '#1a73e8',        -- hex color
    cal_type     VARCHAR(20) NOT NULL DEFAULT 'personal'
                     CHECK (cal_type IN ('personal', 'shared', 'subscription', 'birthday')),
    is_default   BOOLEAN NOT NULL DEFAULT FALSE,
    is_visible   BOOLEAN NOT NULL DEFAULT TRUE,
    is_public    BOOLEAN NOT NULL DEFAULT FALSE,
    timezone     VARCHAR(100) NOT NULL DEFAULT 'UTC',
    -- CalDAV
    caldav_token VARCHAR(64) UNIQUE NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
    ctag         VARCHAR(64) NOT NULL DEFAULT md5(random()::text),
    -- Timestamps
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_calendar_cal_owner ON calendar.calendars(owner_id);
CREATE INDEX idx_calendar_cal_token ON calendar.calendars(caldav_token);

-- Partage de calendriers
CREATE TABLE calendar.calendar_shares (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    calendar_id  UUID NOT NULL REFERENCES calendar.calendars(id) ON DELETE CASCADE,
    shared_with  UUID NOT NULL,            -- user_id
    permission   VARCHAR(20) NOT NULL DEFAULT 'read'
                     CHECK (permission IN ('read', 'write', 'admin')),
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (calendar_id, shared_with)
);

CREATE INDEX idx_calendar_cs_calendar ON calendar.calendar_shares(calendar_id);
CREATE INDEX idx_calendar_cs_user     ON calendar.calendar_shares(shared_with);

-- Événements
CREATE TABLE calendar.events (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    calendar_id      UUID NOT NULL REFERENCES calendar.calendars(id) ON DELETE CASCADE,
    owner_id         UUID NOT NULL,
    title            VARCHAR(500) NOT NULL,
    description      TEXT,
    location         VARCHAR(1000),
    url              VARCHAR(2000),
    -- Dates
    starts_at        TIMESTAMPTZ NOT NULL,
    ends_at          TIMESTAMPTZ NOT NULL,
    all_day          BOOLEAN NOT NULL DEFAULT FALSE,
    timezone         VARCHAR(100) NOT NULL DEFAULT 'UTC',
    -- Récurrence
    rrule            TEXT,                                  -- ex: "FREQ=WEEKLY;BYDAY=MO,WE,FR"
    exdates          TIMESTAMPTZ[] NOT NULL DEFAULT '{}',  -- dates d'exception
    -- Exception d'occurrence récurrente
    parent_event_id  UUID REFERENCES calendar.events(id) ON DELETE CASCADE,
    recurrence_id    TIMESTAMPTZ,                          -- date de l'occurrence remplacée
    -- Rappels: [{"type":"popup","minutes_before":15},...]
    reminders        JSONB NOT NULL DEFAULT '[]',
    -- CalDAV / iCal
    ical_uid         VARCHAR(500) UNIQUE NOT NULL,
    etag             VARCHAR(64) NOT NULL DEFAULT md5(random()::text),
    sequence         INTEGER NOT NULL DEFAULT 0,
    -- Statut
    status           VARCHAR(20) NOT NULL DEFAULT 'confirmed'
                         CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
    visibility       VARCHAR(20) NOT NULL DEFAULT 'public'
                         CHECK (visibility IN ('public', 'private', 'confidential')),
    busy             BOOLEAN NOT NULL DEFAULT TRUE,
    -- Liens cross-modules
    linked_file_ids  UUID[] NOT NULL DEFAULT '{}',
    linked_note_id   UUID,
    linked_task_ids  UUID[] NOT NULL DEFAULT '{}',
    -- Planification de réunion
    meeting_duration_minutes INTEGER,
    -- Timestamps
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT ends_after_starts CHECK (ends_at >= starts_at)
);

CREATE INDEX idx_calendar_ev_calendar  ON calendar.events(calendar_id);
CREATE INDEX idx_calendar_ev_owner     ON calendar.events(owner_id);
CREATE INDEX idx_calendar_ev_starts    ON calendar.events(starts_at);
CREATE INDEX idx_calendar_ev_ends      ON calendar.events(ends_at);
CREATE INDEX idx_calendar_ev_ical_uid  ON calendar.events(ical_uid);
CREATE INDEX idx_calendar_ev_parent    ON calendar.events(parent_event_id) WHERE parent_event_id IS NOT NULL;
CREATE INDEX idx_calendar_ev_range     ON calendar.events(starts_at, ends_at);

-- Trigger updated_at
CREATE OR REPLACE FUNCTION calendar.set_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER calendars_updated_at
    BEFORE UPDATE ON calendar.calendars
    FOR EACH ROW EXECUTE FUNCTION calendar.set_updated_at();

CREATE TRIGGER events_updated_at
    BEFORE UPDATE ON calendar.events
    FOR EACH ROW EXECUTE FUNCTION calendar.set_updated_at();

-- Blocs de temps (disponibilités récurrentes)
CREATE TABLE calendar.time_blocks (
    id         UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    owner_id   UUID NOT NULL,
    label      VARCHAR(255) NOT NULL,
    color      VARCHAR(7) NOT NULL DEFAULT '#34a853',
    days       INTEGER[] NOT NULL DEFAULT '{}',   -- 0=dimanche … 6=samedi
    start_time TIME NOT NULL,
    end_time   TIME NOT NULL,
    priority   VARCHAR(20) NOT NULL DEFAULT 'medium'
                   CHECK (priority IN ('low', 'medium', 'high')),
    is_active  BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT end_after_start CHECK (end_time > start_time)
);

CREATE INDEX idx_calendar_tb_owner ON calendar.time_blocks(owner_id);

CREATE TRIGGER time_blocks_updated_at
    BEFORE UPDATE ON calendar.time_blocks
    FOR EACH ROW EXECUTE FUNCTION calendar.set_updated_at();

-- Rappels planifiés (pour envoi effectif)
CREATE TABLE calendar.scheduled_reminders (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    event_id    UUID NOT NULL REFERENCES calendar.events(id) ON DELETE CASCADE,
    user_id     UUID NOT NULL,
    remind_at   TIMESTAMPTZ NOT NULL,
    channel     VARCHAR(20) NOT NULL DEFAULT 'push'
                    CHECK (channel IN ('push', 'email', 'popup')),
    sent        BOOLEAN NOT NULL DEFAULT FALSE,
    sent_at     TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_calendar_sr_remind ON calendar.scheduled_reminders(remind_at)
    WHERE sent = FALSE;
CREATE INDEX idx_calendar_sr_event  ON calendar.scheduled_reminders(event_id);
