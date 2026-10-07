-- Move the delta layer off PostgreSQL sequences + triggers and onto the
-- application-driven `kubuno_db::journal` primitive (one shared counter row per
-- domain, seqs taken in Rust at write time, tombstones written in the same
-- transaction). Neither the sequence nor the trigger mechanism has a portable
-- form on MySQL/SQLite, so it is retired here on PostgreSQL too; the tombstone
-- TABLES keep their exact shape (no data migration), only their triggers go.
--
-- The `change_seq` columns stay `BIGINT NOT NULL`, but their DEFAULT switches
-- from `nextval(...)` to `0`: the application now supplies every value. The
-- `set_updated_at` triggers from 000001/000003/000008 are deliberately left in
-- place — they keep maintaining `updated_at`; they simply have nothing to do
-- with the change journal, which now moves only through the counter.

-- ── Drop the trigger/function/sequence machinery from 000006 ──────────────────

-- Calendars: BEFORE UPDATE seq, AFTER DELETE tombstone.
DROP TRIGGER IF EXISTS trg_cal_bump      ON calendar.calendars;
DROP TRIGGER IF EXISTS trg_cal_tombstone ON calendar.calendars;
DROP FUNCTION IF EXISTS calendar.cal_bump();
DROP FUNCTION IF EXISTS calendar.cal_tombstone();

-- Events: BEFORE UPDATE seq, AFTER DELETE tombstone, attendee → event bump.
DROP TRIGGER IF EXISTS trg_ev_bump      ON calendar.events;
DROP TRIGGER IF EXISTS trg_ev_tombstone ON calendar.events;
DROP TRIGGER IF EXISTS trg_att_bump     ON calendar.attendees;
DROP FUNCTION IF EXISTS calendar.ev_bump();
DROP FUNCTION IF EXISTS calendar.ev_tombstone();
DROP FUNCTION IF EXISTS calendar.att_bump_event();

-- Time blocks: BEFORE UPDATE seq, AFTER DELETE tombstone.
DROP TRIGGER IF EXISTS trg_tb_bump      ON calendar.time_blocks;
DROP TRIGGER IF EXISTS trg_tb_tombstone ON calendar.time_blocks;
DROP FUNCTION IF EXISTS calendar.tb_bump();
DROP FUNCTION IF EXISTS calendar.tb_tombstone();

-- The DEFAULT references the sequence, so it must go before the sequence does.
ALTER TABLE calendar.calendars   ALTER COLUMN change_seq SET DEFAULT 0;
ALTER TABLE calendar.events      ALTER COLUMN change_seq SET DEFAULT 0;
ALTER TABLE calendar.time_blocks ALTER COLUMN change_seq SET DEFAULT 0;
DROP SEQUENCE IF EXISTS calendar.cal_change_seq;
DROP SEQUENCE IF EXISTS calendar.ev_change_seq;
DROP SEQUENCE IF EXISTS calendar.tb_change_seq;

-- ── The journal's shared counter, seeded to continue the existing sequences ───

CREATE TABLE IF NOT EXISTS calendar.change_counter (
    domain VARCHAR(190) NOT NULL PRIMARY KEY,
    n      BIGINT       NOT NULL
);

-- Seed each domain to the current max so `next_seq` (n := n + 1) never hands out
-- a value an existing row already holds.
INSERT INTO calendar.change_counter (domain, n)
    SELECT 'calendars', COALESCE(MAX(change_seq), 0) FROM calendar.calendars
    ON CONFLICT (domain) DO NOTHING;
INSERT INTO calendar.change_counter (domain, n)
    SELECT 'events', COALESCE(MAX(change_seq), 0) FROM calendar.events
    ON CONFLICT (domain) DO NOTHING;
INSERT INTO calendar.change_counter (domain, n)
    SELECT 'time_blocks', COALESCE(MAX(change_seq), 0) FROM calendar.time_blocks
    ON CONFLICT (domain) DO NOTHING;

-- The tombstone tables (calendar.calendar_tombstones, calendar.event_tombstones,
-- calendar.time_block_tombstones) keep their 000006 shape unchanged; only their
-- triggers were dropped above.
