-- 000003_calendar_scheduling.up.sql

-- Sondages de disponibilité (type Doodle)
CREATE TABLE calendar.meeting_polls (
    id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    organizer_id       UUID NOT NULL,
    title              VARCHAR(500) NOT NULL,
    description        TEXT,
    duration_minutes   INTEGER NOT NULL DEFAULT 60,
    location           VARCHAR(1000),
    public_token       VARCHAR(64) UNIQUE NOT NULL DEFAULT md5(random()::text || clock_timestamp()::text),
    status             VARCHAR(20) NOT NULL DEFAULT 'open'
                           CHECK (status IN ('open', 'closed', 'confirmed', 'cancelled')),
    confirmed_slot_id  UUID,                                  -- rempli quand status='confirmed'
    expires_at         TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_calendar_mp_organizer ON calendar.meeting_polls(organizer_id);
CREATE INDEX idx_calendar_mp_token     ON calendar.meeting_polls(public_token);

-- Créneaux proposés pour un sondage
CREATE TABLE calendar.poll_slots (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    poll_id         UUID NOT NULL REFERENCES calendar.meeting_polls(id) ON DELETE CASCADE,
    starts_at       TIMESTAMPTZ NOT NULL,
    ends_at         TIMESTAMPTZ NOT NULL,
    available_count INTEGER NOT NULL DEFAULT 0,  -- nb de "disponible" mis à jour en trigger
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT poll_slot_ends_after_starts CHECK (ends_at > starts_at)
);

CREATE INDEX idx_calendar_ps_poll ON calendar.poll_slots(poll_id);

-- Réponses aux sondages
CREATE TABLE calendar.poll_responses (
    id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    poll_id      UUID NOT NULL REFERENCES calendar.meeting_polls(id) ON DELETE CASCADE,
    slot_id      UUID NOT NULL REFERENCES calendar.poll_slots(id) ON DELETE CASCADE,
    user_id      UUID,                                        -- NULL si réponse externe
    email        VARCHAR(500) NOT NULL,
    display_name VARCHAR(255),
    availability VARCHAR(20) NOT NULL DEFAULT 'available'
                     CHECK (availability IN ('available', 'maybe', 'unavailable')),
    responded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (slot_id, email)
);

CREATE INDEX idx_calendar_pr_poll ON calendar.poll_responses(poll_id);
CREATE INDEX idx_calendar_pr_slot ON calendar.poll_responses(slot_id);

-- Trigger pour mettre à jour available_count sur poll_slots
CREATE OR REPLACE FUNCTION calendar.update_slot_available_count()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        UPDATE calendar.poll_slots
        SET available_count = (
            SELECT COUNT(*) FROM calendar.poll_responses
            WHERE slot_id = NEW.slot_id AND availability = 'available'
        )
        WHERE id = NEW.slot_id;
    END IF;
    IF TG_OP = 'DELETE' THEN
        UPDATE calendar.poll_slots
        SET available_count = (
            SELECT COUNT(*) FROM calendar.poll_responses
            WHERE slot_id = OLD.slot_id AND availability = 'available'
        )
        WHERE id = OLD.slot_id;
    END IF;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER poll_responses_count
    AFTER INSERT OR UPDATE OR DELETE ON calendar.poll_responses
    FOR EACH ROW EXECUTE FUNCTION calendar.update_slot_available_count();

-- Trigger updated_at sur meeting_polls
CREATE OR REPLACE FUNCTION calendar.set_mp_updated_at()
RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER meeting_polls_updated_at
    BEFORE UPDATE ON calendar.meeting_polls
    FOR EACH ROW EXECUTE FUNCTION calendar.set_mp_updated_at();

-- FK différée: confirmed_slot_id référence poll_slots (créé après)
ALTER TABLE calendar.meeting_polls
    ADD CONSTRAINT fk_confirmed_slot
    FOREIGN KEY (confirmed_slot_id) REFERENCES calendar.poll_slots(id) ON DELETE SET NULL;

-- Vue analytique (charge des événements par utilisateur, 30 derniers jours)
CREATE MATERIALIZED VIEW calendar.analytics_cache AS
SELECT
    e.owner_id,
    DATE_TRUNC('day', e.starts_at) AS day,
    COUNT(*)                        AS event_count,
    SUM(EXTRACT(EPOCH FROM (e.ends_at - e.starts_at)) / 3600) AS total_hours,
    COUNT(*) FILTER (WHERE e.all_day)    AS all_day_count,
    COUNT(*) FILTER (WHERE e.rrule IS NOT NULL) AS recurring_count
FROM calendar.events e
WHERE e.starts_at >= NOW() - INTERVAL '30 days'
  AND e.parent_event_id IS NULL
GROUP BY e.owner_id, DATE_TRUNC('day', e.starts_at);

CREATE UNIQUE INDEX idx_calendar_ac_unique ON calendar.analytics_cache(owner_id, day);
CREATE INDEX idx_calendar_ac_owner ON calendar.analytics_cache(owner_id);
