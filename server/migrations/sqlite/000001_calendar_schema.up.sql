-- SQLite — `calendar` is an ATTACHed database file, attached on every pooled
-- connection by kubuno-db, so the qualified names below resolve as they do on
-- the other two engines. This single file declares the FINAL shape the
-- PostgreSQL side reached across 000001..000014.
--
-- Differences from PostgreSQL, and why:
--   * UUID -> BLOB, TIMESTAMPTZ / TIME / DATE -> TEXT, JSONB / arrays -> TEXT
--     (a JSON array), DOUBLE PRECISION -> REAL, all as sqlx encodes/decodes on
--     SQLite. NaiveTime encodes as 'HH:MM:SS', NaiveDate as 'YYYY-MM-DD'.
--   * No DEFAULT on ids/tokens: SQLite has no UUID/md5 generator the process
--     needs back; it supplies every id, token and JSON array column.
--   * updated_at is maintained by hand-written triggers (SQLite has no ON UPDATE
--     clause and no multi-event triggers). They do not recurse: SQLite leaves
--     recursive_triggers off.
--   * Partial indexes ARE kept (SQLite supports them).
--   * Foreign-key REFERENCES are unqualified (SQLite assumes the same database).
--   * The delta layer is the journal; poll_slots.available_count is refreshed by
--     three AFTER triggers. No materialized analytics_cache view (the analytics
--     service aggregates over `events` directly).

CREATE TABLE calendar.calendars (
    id               BLOB    NOT NULL PRIMARY KEY,
    owner_id         BLOB    NOT NULL,
    name             TEXT    NOT NULL,
    description      TEXT,
    color            TEXT    NOT NULL DEFAULT '#1a73e8',
    cal_type         TEXT    NOT NULL DEFAULT 'personal'
                         CHECK (cal_type IN ('personal', 'shared', 'subscription', 'birthday')),
    is_default       INTEGER NOT NULL DEFAULT 0,
    is_visible       INTEGER NOT NULL DEFAULT 1,
    is_public        INTEGER NOT NULL DEFAULT 0,
    timezone         TEXT    NOT NULL DEFAULT 'UTC',
    caldav_token     TEXT    NOT NULL UNIQUE,
    ctag             TEXT    NOT NULL,
    subscription_url TEXT,
    last_synced_at   TEXT,
    change_seq       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX calendar.idx_calendar_cal_owner      ON calendars(owner_id);
CREATE INDEX calendar.idx_calendar_cal_token      ON calendars(caldav_token);
CREATE INDEX calendar.idx_calendar_cal_change_seq ON calendars(owner_id, change_seq);

CREATE TABLE calendar.calendar_shares (
    id          BLOB NOT NULL PRIMARY KEY,
    calendar_id BLOB NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    shared_with BLOB NOT NULL,
    permission  TEXT NOT NULL DEFAULT 'read'
                    CHECK (permission IN ('read', 'write', 'admin')),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    UNIQUE (calendar_id, shared_with)
);
CREATE INDEX calendar.idx_calendar_cs_calendar ON calendar_shares(calendar_id);
CREATE INDEX calendar.idx_calendar_cs_user     ON calendar_shares(shared_with);

CREATE TABLE calendar.events (
    id               BLOB    NOT NULL PRIMARY KEY,
    calendar_id      BLOB    NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    owner_id         BLOB    NOT NULL,
    title            TEXT    NOT NULL,
    description      TEXT,
    location         TEXT,
    url              TEXT,
    starts_at        TEXT    NOT NULL,
    ends_at          TEXT    NOT NULL,
    all_day          INTEGER NOT NULL DEFAULT 0,
    timezone         TEXT    NOT NULL DEFAULT 'UTC',
    rrule            TEXT,
    exdates          TEXT    NOT NULL,
    parent_event_id  BLOB    REFERENCES events(id) ON DELETE CASCADE,
    recurrence_id    TEXT,
    reminders        TEXT    NOT NULL,
    ical_uid         TEXT    NOT NULL UNIQUE,
    etag             TEXT    NOT NULL,
    sequence         INTEGER NOT NULL DEFAULT 0,
    status           TEXT    NOT NULL DEFAULT 'confirmed'
                         CHECK (status IN ('confirmed', 'tentative', 'cancelled')),
    visibility       TEXT    NOT NULL DEFAULT 'public'
                         CHECK (visibility IN ('public', 'private', 'confidential')),
    busy             INTEGER NOT NULL DEFAULT 1,
    linked_file_ids  TEXT    NOT NULL,
    linked_note_id   BLOB,
    linked_task_ids  TEXT    NOT NULL,
    meeting_duration_minutes INTEGER,
    color            TEXT,
    guests_can_modify     INTEGER NOT NULL DEFAULT 0,
    guests_can_invite     INTEGER NOT NULL DEFAULT 1,
    guests_can_see_guests INTEGER NOT NULL DEFAULT 1,
    change_seq       INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    CONSTRAINT ends_after_starts CHECK (ends_at >= starts_at)
);
CREATE INDEX calendar.idx_calendar_ev_calendar   ON events(calendar_id);
CREATE INDEX calendar.idx_calendar_ev_owner      ON events(owner_id);
CREATE INDEX calendar.idx_calendar_ev_starts     ON events(starts_at);
CREATE INDEX calendar.idx_calendar_ev_ends       ON events(ends_at);
CREATE INDEX calendar.idx_calendar_ev_ical_uid   ON events(ical_uid);
CREATE INDEX calendar.idx_calendar_ev_parent     ON events(parent_event_id) WHERE parent_event_id IS NOT NULL;
CREATE INDEX calendar.idx_calendar_ev_range      ON events(starts_at, ends_at);
CREATE INDEX calendar.idx_calendar_ev_change_seq ON events(calendar_id, change_seq);

CREATE TABLE calendar.time_blocks (
    id         BLOB    NOT NULL PRIMARY KEY,
    owner_id   BLOB    NOT NULL,
    label      TEXT    NOT NULL,
    color      TEXT    NOT NULL DEFAULT '#34a853',
    days       TEXT    NOT NULL,
    start_time TEXT    NOT NULL,
    end_time   TEXT    NOT NULL,
    priority   TEXT    NOT NULL DEFAULT 'medium'
                   CHECK (priority IN ('low', 'medium', 'high')),
    is_active  INTEGER NOT NULL DEFAULT 1,
    change_seq INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    CONSTRAINT end_after_start CHECK (end_time > start_time)
);
CREATE INDEX calendar.idx_calendar_tb_owner      ON time_blocks(owner_id);
CREATE INDEX calendar.idx_calendar_tb_change_seq ON time_blocks(owner_id, change_seq);

CREATE TABLE calendar.scheduled_reminders (
    id         BLOB    NOT NULL PRIMARY KEY,
    event_id   BLOB    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id    BLOB    NOT NULL,
    remind_at  TEXT    NOT NULL,
    channel    TEXT    NOT NULL DEFAULT 'push'
                   CHECK (channel IN ('push', 'email', 'popup')),
    sent       INTEGER NOT NULL DEFAULT 0,
    sent_at    TEXT,
    created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX calendar.idx_calendar_sr_remind ON scheduled_reminders(remind_at) WHERE sent = 0;
CREATE INDEX calendar.idx_calendar_sr_event  ON scheduled_reminders(event_id);

CREATE TABLE calendar.attendees (
    id              BLOB    NOT NULL PRIMARY KEY,
    event_id        BLOB    NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    user_id         BLOB,
    resource_id     BLOB,
    email           TEXT,
    display_name    TEXT,
    status          TEXT    NOT NULL DEFAULT 'needs-action'
                        CHECK (status IN ('needs-action', 'accepted', 'declined', 'tentative')),
    is_organizer    INTEGER NOT NULL DEFAULT 0,
    rsvp_token      TEXT    UNIQUE,
    rsvp_expires_at TEXT,
    invited_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    responded_at    TEXT,
    comment         TEXT,
    last_notified_sequence INTEGER,
    released_at     TEXT,
    optional        INTEGER NOT NULL DEFAULT 0,
    UNIQUE (event_id, email),
    CONSTRAINT attendee_person_xor_resource CHECK ((resource_id IS NULL) <> (email IS NULL))
);
CREATE INDEX        calendar.idx_calendar_att_event    ON attendees(event_id);
CREATE INDEX        calendar.idx_calendar_att_user     ON attendees(user_id)     WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX calendar.idx_calendar_att_event_resource ON attendees(event_id, resource_id) WHERE resource_id IS NOT NULL;
CREATE INDEX        calendar.idx_calendar_att_resource ON attendees(resource_id) WHERE resource_id IS NOT NULL;
CREATE INDEX        calendar.idx_calendar_att_released ON attendees(released_at) WHERE released_at IS NOT NULL;
CREATE INDEX        calendar.idx_calendar_att_token    ON attendees(rsvp_token)  WHERE rsvp_token IS NOT NULL;

CREATE TABLE calendar.meeting_polls (
    id                BLOB    NOT NULL PRIMARY KEY,
    organizer_id      BLOB    NOT NULL,
    title             TEXT    NOT NULL,
    description       TEXT,
    duration_minutes  INTEGER NOT NULL DEFAULT 60,
    location          TEXT,
    public_token      TEXT    NOT NULL UNIQUE,
    status            TEXT    NOT NULL DEFAULT 'open'
                          CHECK (status IN ('open', 'closed', 'confirmed', 'cancelled')),
    confirmed_slot_id BLOB,
    expires_at        TEXT,
    created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX calendar.idx_calendar_mp_organizer ON meeting_polls(organizer_id);
CREATE INDEX calendar.idx_calendar_mp_token     ON meeting_polls(public_token);

CREATE TABLE calendar.poll_slots (
    id              BLOB    NOT NULL PRIMARY KEY,
    poll_id         BLOB    NOT NULL REFERENCES meeting_polls(id) ON DELETE CASCADE,
    starts_at       TEXT    NOT NULL,
    ends_at         TEXT    NOT NULL,
    available_count INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    CONSTRAINT poll_slot_ends_after_starts CHECK (ends_at > starts_at)
);
CREATE INDEX calendar.idx_calendar_ps_poll ON poll_slots(poll_id);

CREATE TABLE calendar.poll_responses (
    id           BLOB    NOT NULL PRIMARY KEY,
    poll_id      BLOB    NOT NULL REFERENCES meeting_polls(id) ON DELETE CASCADE,
    slot_id      BLOB    NOT NULL REFERENCES poll_slots(id)    ON DELETE CASCADE,
    user_id      BLOB,
    email        TEXT    NOT NULL,
    display_name TEXT,
    availability TEXT    NOT NULL DEFAULT 'available'
                     CHECK (availability IN ('available', 'maybe', 'unavailable')),
    responded_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    UNIQUE (slot_id, email)
);
CREATE INDEX calendar.idx_calendar_pr_poll ON poll_responses(poll_id);
CREATE INDEX calendar.idx_calendar_pr_slot ON poll_responses(slot_id);

CREATE TABLE calendar.appointment_schedules (
    id                 BLOB    NOT NULL PRIMARY KEY,
    owner_id           BLOB    NOT NULL,
    calendar_id        BLOB    NOT NULL REFERENCES calendars(id) ON DELETE CASCADE,
    public_token       TEXT    NOT NULL UNIQUE,
    title              TEXT    NOT NULL DEFAULT '',
    description        TEXT,
    color              TEXT,
    duration_minutes   INTEGER NOT NULL DEFAULT 60 CHECK (duration_minutes > 0),
    buffer_minutes     INTEGER CHECK (buffer_minutes IS NULL OR buffer_minutes >= 0),
    max_per_day        INTEGER CHECK (max_per_day IS NULL OR max_per_day > 0),
    timezone           TEXT    NOT NULL DEFAULT 'UTC',
    window_type        TEXT    NOT NULL DEFAULT 'rolling'
                           CHECK (window_type IN ('rolling', 'fixed')),
    window_max_days    INTEGER CHECK (window_max_days IS NULL OR window_max_days > 0),
    window_min_hours   INTEGER CHECK (window_min_hours IS NULL OR window_min_hours >= 0),
    window_start_date  TEXT,
    window_end_date    TEXT,
    location_type      TEXT    NOT NULL DEFAULT 'none'
                           CHECK (location_type IN ('none', 'in_person', 'phone', 'video')),
    location_details   TEXT,
    guests_can_invite  INTEGER NOT NULL DEFAULT 1,
    host_name          TEXT,
    host_avatar_url    TEXT,
    form_fields        TEXT    NOT NULL,
    calendar_invite    INTEGER NOT NULL DEFAULT 1,
    email_reminders    TEXT    NOT NULL,
    created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX calendar.idx_calendar_as_owner    ON appointment_schedules(owner_id);
CREATE INDEX calendar.idx_calendar_as_token    ON appointment_schedules(public_token);
CREATE INDEX calendar.idx_calendar_as_calendar ON appointment_schedules(calendar_id);

CREATE TABLE calendar.appointment_availability (
    id             BLOB    NOT NULL PRIMARY KEY,
    schedule_id    BLOB    NOT NULL REFERENCES appointment_schedules(id) ON DELETE CASCADE,
    weekday        INTEGER CHECK (weekday IS NULL OR (weekday BETWEEN 0 AND 6)),
    specific_date  TEXT,
    start_minute   INTEGER NOT NULL CHECK (start_minute >= 0 AND start_minute < 1440),
    end_minute     INTEGER NOT NULL CHECK (end_minute > 0 AND end_minute <= 1440),
    CONSTRAINT appt_avail_end_after_start CHECK (end_minute > start_minute),
    CONSTRAINT appt_avail_kind CHECK ((weekday IS NULL) <> (specific_date IS NULL))
);
CREATE INDEX calendar.idx_calendar_aa_schedule ON appointment_availability(schedule_id);

CREATE TABLE calendar.appointment_bookings (
    id            BLOB    NOT NULL PRIMARY KEY,
    schedule_id   BLOB    NOT NULL REFERENCES appointment_schedules(id) ON DELETE CASCADE,
    starts_at     TEXT    NOT NULL,
    ends_at       TEXT    NOT NULL,
    first_name    TEXT    NOT NULL,
    last_name     TEXT,
    email         TEXT    NOT NULL,
    answers       TEXT    NOT NULL,
    note          TEXT,
    event_id      BLOB    REFERENCES events(id) ON DELETE SET NULL,
    status        TEXT    NOT NULL DEFAULT 'confirmed'
                      CHECK (status IN ('confirmed', 'cancelled')),
    created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now')),
    CONSTRAINT appt_booking_ends_after_starts CHECK (ends_at > starts_at)
);
CREATE INDEX calendar.idx_calendar_ab_schedule ON appointment_bookings(schedule_id);
CREATE INDEX calendar.idx_calendar_ab_starts   ON appointment_bookings(starts_at);

CREATE TABLE calendar.weather_locations (
    id          BLOB    NOT NULL PRIMARY KEY,
    user_id     BLOB    NOT NULL,
    name        TEXT    NOT NULL,
    latitude    REAL    NOT NULL,
    longitude   REAL    NOT NULL,
    timezone    TEXT    NOT NULL DEFAULT 'UTC',
    is_default  INTEGER NOT NULL DEFAULT 0,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX calendar.idx_calendar_wl_user ON weather_locations(user_id);

-- ── Delta journal: one shared counter, one tombstone table per entity ─────────

CREATE TABLE calendar.change_counter (
    domain TEXT    NOT NULL PRIMARY KEY,
    n      INTEGER NOT NULL
);

CREATE TABLE calendar.calendar_tombstones (
    id         BLOB    NOT NULL PRIMARY KEY,
    owner_id   BLOB    NOT NULL,
    change_seq INTEGER NOT NULL,
    deleted_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX calendar.idx_calendar_cal_tomb ON calendar_tombstones(owner_id, change_seq);

CREATE TABLE calendar.event_tombstones (
    id         BLOB    NOT NULL PRIMARY KEY,
    owner_id   BLOB    NOT NULL,
    change_seq INTEGER NOT NULL,
    deleted_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX calendar.idx_calendar_ev_tomb ON event_tombstones(owner_id, change_seq);

CREATE TABLE calendar.time_block_tombstones (
    id         BLOB    NOT NULL PRIMARY KEY,
    owner_id   BLOB    NOT NULL,
    change_seq INTEGER NOT NULL,
    deleted_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%f', 'now'))
);
CREATE INDEX calendar.idx_calendar_tb_tomb ON time_block_tombstones(owner_id, change_seq);

-- ── updated_at maintenance (hand-written; no recursion) ───────────────────────

CREATE TRIGGER calendar.calendars_updated_at AFTER UPDATE ON calendars
BEGIN
    UPDATE calendars SET updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER calendar.events_updated_at AFTER UPDATE ON events
BEGIN
    UPDATE events SET updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER calendar.time_blocks_updated_at AFTER UPDATE ON time_blocks
BEGIN
    UPDATE time_blocks SET updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER calendar.meeting_polls_updated_at AFTER UPDATE ON meeting_polls
BEGIN
    UPDATE meeting_polls SET updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = NEW.id;
END;
CREATE TRIGGER calendar.appointment_schedules_updated_at AFTER UPDATE ON appointment_schedules
BEGIN
    UPDATE appointment_schedules SET updated_at = strftime('%Y-%m-%d %H:%M:%f', 'now') WHERE id = NEW.id;
END;

-- ── poll_slots.available_count: refreshed whenever a response changes ─────────

CREATE TRIGGER calendar.calendar_pr_count_ins AFTER INSERT ON poll_responses
BEGIN
    UPDATE poll_slots SET available_count = (
        SELECT COUNT(*) FROM poll_responses WHERE slot_id = NEW.slot_id AND availability = 'available'
    ) WHERE id = NEW.slot_id;
END;
CREATE TRIGGER calendar.calendar_pr_count_upd AFTER UPDATE ON poll_responses
BEGIN
    UPDATE poll_slots SET available_count = (
        SELECT COUNT(*) FROM poll_responses WHERE slot_id = NEW.slot_id AND availability = 'available'
    ) WHERE id = NEW.slot_id;
END;
CREATE TRIGGER calendar.calendar_pr_count_del AFTER DELETE ON poll_responses
BEGIN
    UPDATE poll_slots SET available_count = (
        SELECT COUNT(*) FROM poll_responses WHERE slot_id = OLD.slot_id AND availability = 'available'
    ) WHERE id = OLD.slot_id;
END;
