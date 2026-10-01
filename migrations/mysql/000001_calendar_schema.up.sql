-- MySQL / MariaDB — the `calendar` database is created by kubuno-db's
-- `ensure_schema` before the migrator runs, so there is no CREATE DATABASE here.
-- This single file declares the FINAL shape the PostgreSQL side reached across
-- its 000001..000014 migrations (delta journal included; exdates / linked_*_ids
-- and time_blocks.days as JSON), stated once.
--
-- Differences from PostgreSQL, and why:
--   * UUID -> BINARY(16): what sqlx encodes a `uuid::Uuid` as on MySQL.
--   * No DEFAULT on ids and tokens: MySQL has no gen_random_uuid()/md5 default
--     the process needs back, and no RETURNING — so it supplies every id, every
--     caldav_token / ctag / etag / public_token, and every JSON array column.
--   * TIMESTAMPTZ -> DATETIME(6); every value written is UTC (the pool pins
--     `time_zone = '+00:00'`). TIME/DATE keep their native MySQL types.
--   * JSONB / arrays -> JSON (reminders, exdates, linked_file_ids,
--     linked_task_ids, days, form_fields, email_reminders, answers).
--   * updated_at is maintained by ON UPDATE CURRENT_TIMESTAMP(6).
--   * No partial indexes (MySQL has none): the WHERE-filtered indexes become
--     plain indexes; the "one room once per event" unique tolerates the NULL
--     resource_id of people (MySQL does not compare NULLs as equal).
--   * The delta layer is the journal (change_counter + per-row change_seq);
--     poll_slots.available_count is refreshed by three AFTER triggers.
--   * No materialized analytics_cache view: the analytics service aggregates
--     over `events` directly.

CREATE TABLE calendar.calendars (
    id               BINARY(16)   NOT NULL PRIMARY KEY,
    owner_id         BINARY(16)   NOT NULL,
    name             VARCHAR(255) NOT NULL,
    description      TEXT         NULL,
    color            VARCHAR(7)   NOT NULL DEFAULT '#1a73e8',
    cal_type         VARCHAR(20)  NOT NULL DEFAULT 'personal'
                         CHECK (cal_type IN ('personal', 'shared', 'subscription', 'birthday')),
    is_default       BOOLEAN      NOT NULL DEFAULT FALSE,
    is_visible       BOOLEAN      NOT NULL DEFAULT TRUE,
    is_public        BOOLEAN      NOT NULL DEFAULT FALSE,
    timezone         VARCHAR(100) NOT NULL DEFAULT 'UTC',
    caldav_token     VARCHAR(64)  NOT NULL UNIQUE,
    ctag             VARCHAR(64)  NOT NULL,
    subscription_url TEXT         NULL,
    last_synced_at   DATETIME(6)  NULL,
    change_seq       BIGINT       NOT NULL DEFAULT 0,
    created_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at       DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                  ON UPDATE CURRENT_TIMESTAMP(6)
);
CREATE INDEX idx_calendar_cal_owner      ON calendar.calendars(owner_id);
CREATE INDEX idx_calendar_cal_token      ON calendar.calendars(caldav_token);
CREATE INDEX idx_calendar_cal_change_seq ON calendar.calendars(owner_id, change_seq);

CREATE TABLE calendar.calendar_shares (
    id          BINARY(16)  NOT NULL PRIMARY KEY,
    calendar_id BINARY(16)  NOT NULL,
    shared_with BINARY(16)  NOT NULL,
    permission  VARCHAR(20) NOT NULL DEFAULT 'read'
                    CHECK (permission IN ('read', 'write', 'admin')),
    created_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE (calendar_id, shared_with),
    FOREIGN KEY (calendar_id) REFERENCES calendar.calendars(id) ON DELETE CASCADE
);
CREATE INDEX idx_calendar_cs_calendar ON calendar.calendar_shares(calendar_id);
CREATE INDEX idx_calendar_cs_user     ON calendar.calendar_shares(shared_with);

CREATE TABLE calendar.events (
    id               BINARY(16)    NOT NULL PRIMARY KEY,
    calendar_id      BINARY(16)    NOT NULL,
    owner_id         BINARY(16)    NOT NULL,
    title            VARCHAR(500)  NOT NULL,
    description      TEXT          NULL,
    location         VARCHAR(1000) NULL,
    url              VARCHAR(2000) NULL,
    starts_at        DATETIME(6)   NOT NULL,
    ends_at          DATETIME(6)   NOT NULL,
    all_day          BOOLEAN       NOT NULL DEFAULT FALSE,
    timezone         VARCHAR(100)  NOT NULL DEFAULT 'UTC',
    rrule            TEXT          NULL,
    exdates          JSON          NOT NULL,
    parent_event_id  BINARY(16)    NULL,
    recurrence_id    DATETIME(6)   NULL,
    reminders        JSON          NOT NULL,
    ical_uid         VARCHAR(500)  NOT NULL UNIQUE,
    etag             VARCHAR(64)   NOT NULL,
    sequence         INT           NOT NULL DEFAULT 0,
    status           VARCHAR(20)   NOT NULL DEFAULT 'confirmed'
                         CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
    visibility       VARCHAR(20)   NOT NULL DEFAULT 'public'
                         CHECK (visibility IN ('public', 'private', 'confidential')),
    busy             BOOLEAN       NOT NULL DEFAULT TRUE,
    linked_file_ids  JSON          NOT NULL,
    linked_note_id   BINARY(16)    NULL,
    linked_task_ids  JSON          NOT NULL,
    meeting_duration_minutes INT   NULL,
    color            VARCHAR(7)    NULL,
    guests_can_modify     BOOLEAN  NOT NULL DEFAULT FALSE,
    guests_can_invite     BOOLEAN  NOT NULL DEFAULT TRUE,
    guests_can_see_guests BOOLEAN  NOT NULL DEFAULT TRUE,
    change_seq       BIGINT        NOT NULL DEFAULT 0,
    created_at       DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at       DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                   ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT ends_after_starts CHECK (ends_at >= starts_at),
    FOREIGN KEY (calendar_id)     REFERENCES calendar.calendars(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_event_id) REFERENCES calendar.events(id)    ON DELETE CASCADE
);
CREATE INDEX idx_calendar_ev_calendar   ON calendar.events(calendar_id);
CREATE INDEX idx_calendar_ev_owner      ON calendar.events(owner_id);
CREATE INDEX idx_calendar_ev_starts     ON calendar.events(starts_at);
CREATE INDEX idx_calendar_ev_ends       ON calendar.events(ends_at);
CREATE INDEX idx_calendar_ev_ical_uid   ON calendar.events(ical_uid);
CREATE INDEX idx_calendar_ev_parent     ON calendar.events(parent_event_id);
CREATE INDEX idx_calendar_ev_range      ON calendar.events(starts_at, ends_at);
CREATE INDEX idx_calendar_ev_change_seq ON calendar.events(calendar_id, change_seq);

CREATE TABLE calendar.time_blocks (
    id         BINARY(16)   NOT NULL PRIMARY KEY,
    owner_id   BINARY(16)   NOT NULL,
    label      VARCHAR(255) NOT NULL,
    color      VARCHAR(7)   NOT NULL DEFAULT '#34a853',
    days       JSON         NOT NULL,
    start_time TIME         NOT NULL,
    end_time   TIME         NOT NULL,
    priority   VARCHAR(20)  NOT NULL DEFAULT 'medium'
                   CHECK (priority IN ('low', 'medium', 'high')),
    is_active  BOOLEAN      NOT NULL DEFAULT TRUE,
    change_seq BIGINT       NOT NULL DEFAULT 0,
    created_at DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                            ON UPDATE CURRENT_TIMESTAMP(6),
    CONSTRAINT end_after_start CHECK (end_time > start_time)
);
CREATE INDEX idx_calendar_tb_owner      ON calendar.time_blocks(owner_id);
CREATE INDEX idx_calendar_tb_change_seq ON calendar.time_blocks(owner_id, change_seq);

CREATE TABLE calendar.scheduled_reminders (
    id         BINARY(16)  NOT NULL PRIMARY KEY,
    event_id   BINARY(16)  NOT NULL,
    user_id    BINARY(16)  NOT NULL,
    remind_at  DATETIME(6) NOT NULL,
    channel    VARCHAR(20) NOT NULL DEFAULT 'push'
                   CHECK (channel IN ('push', 'email', 'popup')),
    sent       BOOLEAN     NOT NULL DEFAULT FALSE,
    sent_at    DATETIME(6) NULL,
    created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    FOREIGN KEY (event_id) REFERENCES calendar.events(id) ON DELETE CASCADE
);
CREATE INDEX idx_calendar_sr_remind ON calendar.scheduled_reminders(remind_at);
CREATE INDEX idx_calendar_sr_event  ON calendar.scheduled_reminders(event_id);

CREATE TABLE calendar.attendees (
    id              BINARY(16)   NOT NULL PRIMARY KEY,
    event_id        BINARY(16)   NOT NULL,
    user_id         BINARY(16)   NULL,
    resource_id     BINARY(16)   NULL,
    email           VARCHAR(500) NULL,
    display_name    VARCHAR(255) NULL,
    status          VARCHAR(20)  NOT NULL DEFAULT 'needs-action'
                        CHECK (status IN ('needs-action', 'accepted', 'declined', 'tentative')),
    is_organizer    BOOLEAN      NOT NULL DEFAULT FALSE,
    rsvp_token      VARCHAR(64)  NULL UNIQUE,
    rsvp_expires_at DATETIME(6)  NULL,
    invited_at      DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    responded_at    DATETIME(6)  NULL,
    comment         TEXT         NULL,
    last_notified_sequence INT   NULL,
    released_at     DATETIME(6)  NULL,
    optional        BOOLEAN      NOT NULL DEFAULT FALSE,
    UNIQUE (event_id, email),
    UNIQUE (event_id, resource_id),
    CONSTRAINT attendee_person_xor_resource CHECK ((resource_id IS NULL) <> (email IS NULL)),
    FOREIGN KEY (event_id) REFERENCES calendar.events(id) ON DELETE CASCADE
);
CREATE INDEX idx_calendar_att_event    ON calendar.attendees(event_id);
CREATE INDEX idx_calendar_att_user     ON calendar.attendees(user_id);
CREATE INDEX idx_calendar_att_resource ON calendar.attendees(resource_id);
CREATE INDEX idx_calendar_att_released ON calendar.attendees(released_at);

CREATE TABLE calendar.meeting_polls (
    id                BINARY(16)   NOT NULL PRIMARY KEY,
    organizer_id      BINARY(16)   NOT NULL,
    title             VARCHAR(500) NOT NULL,
    description       TEXT         NULL,
    duration_minutes  INT          NOT NULL DEFAULT 60,
    location          VARCHAR(1000) NULL,
    public_token      VARCHAR(64)  NOT NULL UNIQUE,
    status            VARCHAR(20)  NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'closed', 'confirmed', 'cancelled')),
    confirmed_slot_id BINARY(16)   NULL,
    expires_at        DATETIME(6)  NULL,
    created_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                   ON UPDATE CURRENT_TIMESTAMP(6)
);
CREATE INDEX idx_calendar_mp_organizer ON calendar.meeting_polls(organizer_id);
CREATE INDEX idx_calendar_mp_token     ON calendar.meeting_polls(public_token);

CREATE TABLE calendar.poll_slots (
    id              BINARY(16)  NOT NULL PRIMARY KEY,
    poll_id         BINARY(16)  NOT NULL,
    starts_at       DATETIME(6) NOT NULL,
    ends_at         DATETIME(6) NOT NULL,
    available_count INT         NOT NULL DEFAULT 0,
    created_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT poll_slot_ends_after_starts CHECK (ends_at > starts_at),
    FOREIGN KEY (poll_id) REFERENCES calendar.meeting_polls(id) ON DELETE CASCADE
);
CREATE INDEX idx_calendar_ps_poll ON calendar.poll_slots(poll_id);

CREATE TABLE calendar.poll_responses (
    id           BINARY(16)   NOT NULL PRIMARY KEY,
    poll_id      BINARY(16)   NOT NULL,
    slot_id      BINARY(16)   NOT NULL,
    user_id      BINARY(16)   NULL,
    email        VARCHAR(500) NOT NULL,
    display_name VARCHAR(255) NULL,
    availability VARCHAR(20)  NOT NULL DEFAULT 'available'
                     CHECK (availability IN ('available', 'maybe', 'unavailable')),
    responded_at DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    UNIQUE (slot_id, email),
    FOREIGN KEY (poll_id) REFERENCES calendar.meeting_polls(id) ON DELETE CASCADE,
    FOREIGN KEY (slot_id) REFERENCES calendar.poll_slots(id)    ON DELETE CASCADE
);
CREATE INDEX idx_calendar_pr_poll ON calendar.poll_responses(poll_id);
CREATE INDEX idx_calendar_pr_slot ON calendar.poll_responses(slot_id);

ALTER TABLE calendar.meeting_polls
    ADD CONSTRAINT fk_confirmed_slot
    FOREIGN KEY (confirmed_slot_id) REFERENCES calendar.poll_slots(id) ON DELETE SET NULL;

CREATE TABLE calendar.appointment_schedules (
    id                 BINARY(16)   NOT NULL PRIMARY KEY,
    owner_id           BINARY(16)   NOT NULL,
    calendar_id        BINARY(16)   NOT NULL,
    public_token       VARCHAR(64)  NOT NULL UNIQUE,
    title              VARCHAR(500) NOT NULL DEFAULT '',
    description        TEXT         NULL,
    color              VARCHAR(20)  NULL,
    duration_minutes   INT          NOT NULL DEFAULT 60 CHECK (duration_minutes > 0),
    buffer_minutes     INT          NULL CHECK (buffer_minutes IS NULL OR buffer_minutes >= 0),
    max_per_day        INT          NULL CHECK (max_per_day IS NULL OR max_per_day > 0),
    timezone           VARCHAR(64)  NOT NULL DEFAULT 'UTC',
    window_type        VARCHAR(20)  NOT NULL DEFAULT 'rolling'
                           CHECK (window_type IN ('rolling', 'fixed')),
    window_max_days    INT          NULL CHECK (window_max_days IS NULL OR window_max_days > 0),
    window_min_hours   INT          NULL CHECK (window_min_hours IS NULL OR window_min_hours >= 0),
    window_start_date  DATE         NULL,
    window_end_date    DATE         NULL,
    location_type      VARCHAR(20)  NOT NULL DEFAULT 'none'
                           CHECK (location_type IN ('none', 'in_person', 'phone', 'video')),
    location_details   TEXT         NULL,
    guests_can_invite  BOOLEAN      NOT NULL DEFAULT TRUE,
    host_name          VARCHAR(255) NULL,
    host_avatar_url    VARCHAR(1000) NULL,
    form_fields        JSON         NOT NULL,
    calendar_invite    BOOLEAN      NOT NULL DEFAULT TRUE,
    email_reminders    JSON         NOT NULL,
    created_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    updated_at         DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
                                    ON UPDATE CURRENT_TIMESTAMP(6),
    FOREIGN KEY (calendar_id) REFERENCES calendar.calendars(id) ON DELETE CASCADE
);
CREATE INDEX idx_calendar_as_owner    ON calendar.appointment_schedules(owner_id);
CREATE INDEX idx_calendar_as_token    ON calendar.appointment_schedules(public_token);
CREATE INDEX idx_calendar_as_calendar ON calendar.appointment_schedules(calendar_id);

CREATE TABLE calendar.appointment_availability (
    id             BINARY(16) NOT NULL PRIMARY KEY,
    schedule_id    BINARY(16) NOT NULL,
    weekday        SMALLINT   NULL CHECK (weekday IS NULL OR (weekday BETWEEN 0 AND 6)),
    specific_date  DATE       NULL,
    start_minute   INT        NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
    end_minute     INT        NOT NULL CHECK (end_minute > 0 AND end_minute <= 1440),
    CONSTRAINT appt_avail_end_after_start CHECK (end_minute > start_minute),
    CONSTRAINT appt_avail_kind CHECK ((weekday IS NULL) <> (specific_date IS NULL)),
    FOREIGN KEY (schedule_id) REFERENCES calendar.appointment_schedules(id) ON DELETE CASCADE
);
CREATE INDEX idx_calendar_aa_schedule ON calendar.appointment_availability(schedule_id);

CREATE TABLE calendar.appointment_bookings (
    id            BINARY(16)   NOT NULL PRIMARY KEY,
    schedule_id   BINARY(16)   NOT NULL,
    starts_at     DATETIME(6)  NOT NULL,
    ends_at       DATETIME(6)  NOT NULL,
    first_name    VARCHAR(255) NOT NULL,
    last_name     VARCHAR(255) NULL,
    email         VARCHAR(500) NOT NULL,
    answers       JSON         NOT NULL,
    note          TEXT         NULL,
    event_id      BINARY(16)   NULL,
    status        VARCHAR(20)  NOT NULL DEFAULT 'confirmed'
                      CHECK (status IN ('confirmed', 'cancelled')),
    created_at    DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    CONSTRAINT appt_booking_ends_after_starts CHECK (ends_at > starts_at),
    FOREIGN KEY (schedule_id) REFERENCES calendar.appointment_schedules(id) ON DELETE CASCADE,
    FOREIGN KEY (event_id)    REFERENCES calendar.events(id)                ON DELETE SET NULL
);
CREATE INDEX idx_calendar_ab_schedule ON calendar.appointment_bookings(schedule_id);
CREATE INDEX idx_calendar_ab_starts   ON calendar.appointment_bookings(starts_at);

CREATE TABLE calendar.weather_locations (
    id          BINARY(16)   NOT NULL PRIMARY KEY,
    user_id     BINARY(16)   NOT NULL,
    name        VARCHAR(255) NOT NULL,
    latitude    DOUBLE       NOT NULL,
    longitude   DOUBLE       NOT NULL,
    timezone    VARCHAR(100) NOT NULL DEFAULT 'UTC',
    is_default  BOOLEAN      NOT NULL DEFAULT FALSE,
    sort_order  INT          NOT NULL DEFAULT 0,
    created_at  DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CREATE INDEX idx_calendar_wl_user ON calendar.weather_locations(user_id);

-- ── Delta journal: one shared counter, one tombstone table per entity ─────────

CREATE TABLE calendar.change_counter (
    domain VARCHAR(190) NOT NULL PRIMARY KEY,
    n      BIGINT       NOT NULL
);

CREATE TABLE calendar.calendar_tombstones (
    id         BINARY(16)  NOT NULL PRIMARY KEY,
    owner_id   BINARY(16)  NOT NULL,
    change_seq BIGINT      NOT NULL,
    deleted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CREATE INDEX idx_calendar_cal_tomb ON calendar.calendar_tombstones(owner_id, change_seq);

CREATE TABLE calendar.event_tombstones (
    id         BINARY(16)  NOT NULL PRIMARY KEY,
    owner_id   BINARY(16)  NOT NULL,
    change_seq BIGINT      NOT NULL,
    deleted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CREATE INDEX idx_calendar_ev_tomb ON calendar.event_tombstones(owner_id, change_seq);

CREATE TABLE calendar.time_block_tombstones (
    id         BINARY(16)  NOT NULL PRIMARY KEY,
    owner_id   BINARY(16)  NOT NULL,
    change_seq BIGINT      NOT NULL,
    deleted_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)
);
CREATE INDEX idx_calendar_tb_tomb ON calendar.time_block_tombstones(owner_id, change_seq);

-- ── poll_slots.available_count: refreshed whenever a response changes ─────────

CREATE TRIGGER calendar_pr_count_ins AFTER INSERT ON calendar.poll_responses FOR EACH ROW
    UPDATE calendar.poll_slots SET available_count = (
        SELECT COUNT(*) FROM calendar.poll_responses
        WHERE slot_id = NEW.slot_id AND availability = 'available'
    ) WHERE id = NEW.slot_id;
CREATE TRIGGER calendar_pr_count_upd AFTER UPDATE ON calendar.poll_responses FOR EACH ROW
    UPDATE calendar.poll_slots SET available_count = (
        SELECT COUNT(*) FROM calendar.poll_responses
        WHERE slot_id = NEW.slot_id AND availability = 'available'
    ) WHERE id = NEW.slot_id;
CREATE TRIGGER calendar_pr_count_del AFTER DELETE ON calendar.poll_responses FOR EACH ROW
    UPDATE calendar.poll_slots SET available_count = (
        SELECT COUNT(*) FROM calendar.poll_responses
        WHERE slot_id = OLD.slot_id AND availability = 'available'
    ) WHERE id = OLD.slot_id;
