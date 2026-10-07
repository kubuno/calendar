-- Delta primitives for the local-first pull (calendars, events, time_blocks).
-- Events (base + per-occurrence exceptions) are hard-deleted → tombstones.
-- Attendees bump their event (they ride inline in the event delta, read-only).

-- ===== helper: generic bump + tombstone per table =====
-- calendars
ALTER TABLE calendar.calendars ADD COLUMN IF NOT EXISTS change_seq BIGINT;
CREATE SEQUENCE IF NOT EXISTS calendar.cal_change_seq;
UPDATE calendar.calendars SET change_seq = nextval('calendar.cal_change_seq') WHERE change_seq IS NULL;
ALTER TABLE calendar.calendars ALTER COLUMN change_seq SET NOT NULL;
ALTER TABLE calendar.calendars ALTER COLUMN change_seq SET DEFAULT nextval('calendar.cal_change_seq');
CREATE INDEX IF NOT EXISTS idx_cal_change_seq ON calendar.calendars(owner_id, change_seq);
CREATE OR REPLACE FUNCTION calendar.cal_bump() RETURNS trigger AS $$
BEGIN NEW.change_seq := nextval('calendar.cal_change_seq'); RETURN NEW; END;$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_cal_bump ON calendar.calendars;
CREATE TRIGGER trg_cal_bump BEFORE UPDATE ON calendar.calendars FOR EACH ROW EXECUTE FUNCTION calendar.cal_bump();
CREATE TABLE IF NOT EXISTS calendar.calendar_tombstones (
    id UUID PRIMARY KEY, owner_id UUID NOT NULL, change_seq BIGINT NOT NULL, deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_cal_tomb ON calendar.calendar_tombstones(owner_id, change_seq);
CREATE OR REPLACE FUNCTION calendar.cal_tombstone() RETURNS trigger AS $$
BEGIN
    INSERT INTO calendar.calendar_tombstones (id, owner_id, change_seq)
    VALUES (OLD.id, OLD.owner_id, nextval('calendar.cal_change_seq'))
    ON CONFLICT (id) DO UPDATE SET change_seq = EXCLUDED.change_seq, deleted_at = NOW();
    RETURN OLD; END;$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_cal_tombstone ON calendar.calendars;
CREATE TRIGGER trg_cal_tombstone AFTER DELETE ON calendar.calendars FOR EACH ROW EXECUTE FUNCTION calendar.cal_tombstone();

-- events
ALTER TABLE calendar.events ADD COLUMN IF NOT EXISTS change_seq BIGINT;
CREATE SEQUENCE IF NOT EXISTS calendar.ev_change_seq;
UPDATE calendar.events SET change_seq = nextval('calendar.ev_change_seq') WHERE change_seq IS NULL;
ALTER TABLE calendar.events ALTER COLUMN change_seq SET NOT NULL;
ALTER TABLE calendar.events ALTER COLUMN change_seq SET DEFAULT nextval('calendar.ev_change_seq');
CREATE INDEX IF NOT EXISTS idx_ev_change_seq ON calendar.events(calendar_id, change_seq);
CREATE OR REPLACE FUNCTION calendar.ev_bump() RETURNS trigger AS $$
BEGIN NEW.change_seq := nextval('calendar.ev_change_seq'); RETURN NEW; END;$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_ev_bump ON calendar.events;
CREATE TRIGGER trg_ev_bump BEFORE UPDATE ON calendar.events FOR EACH ROW EXECUTE FUNCTION calendar.ev_bump();
CREATE TABLE IF NOT EXISTS calendar.event_tombstones (
    id UUID PRIMARY KEY, owner_id UUID NOT NULL, change_seq BIGINT NOT NULL, deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_ev_tomb ON calendar.event_tombstones(owner_id, change_seq);
CREATE OR REPLACE FUNCTION calendar.ev_tombstone() RETURNS trigger AS $$
BEGIN
    INSERT INTO calendar.event_tombstones (id, owner_id, change_seq)
    VALUES (OLD.id, OLD.owner_id, nextval('calendar.ev_change_seq'))
    ON CONFLICT (id) DO UPDATE SET change_seq = EXCLUDED.change_seq, deleted_at = NOW();
    RETURN OLD; END;$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_ev_tombstone ON calendar.events;
CREATE TRIGGER trg_ev_tombstone AFTER DELETE ON calendar.events FOR EACH ROW EXECUTE FUNCTION calendar.ev_tombstone();

-- attendees bump their event (inline in the event delta)
CREATE OR REPLACE FUNCTION calendar.att_bump_event() RETURNS trigger AS $$
BEGIN
    UPDATE calendar.events SET change_seq = change_seq WHERE id = COALESCE(NEW.event_id, OLD.event_id);
    RETURN COALESCE(NEW, OLD); END;$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_att_bump ON calendar.attendees;
CREATE TRIGGER trg_att_bump AFTER INSERT OR UPDATE OR DELETE ON calendar.attendees FOR EACH ROW EXECUTE FUNCTION calendar.att_bump_event();

-- time_blocks
ALTER TABLE calendar.time_blocks ADD COLUMN IF NOT EXISTS change_seq BIGINT;
CREATE SEQUENCE IF NOT EXISTS calendar.tb_change_seq;
UPDATE calendar.time_blocks SET change_seq = nextval('calendar.tb_change_seq') WHERE change_seq IS NULL;
ALTER TABLE calendar.time_blocks ALTER COLUMN change_seq SET NOT NULL;
ALTER TABLE calendar.time_blocks ALTER COLUMN change_seq SET DEFAULT nextval('calendar.tb_change_seq');
CREATE INDEX IF NOT EXISTS idx_tb_change_seq ON calendar.time_blocks(owner_id, change_seq);
CREATE OR REPLACE FUNCTION calendar.tb_bump() RETURNS trigger AS $$
BEGIN NEW.change_seq := nextval('calendar.tb_change_seq'); RETURN NEW; END;$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_tb_bump ON calendar.time_blocks;
CREATE TRIGGER trg_tb_bump BEFORE UPDATE ON calendar.time_blocks FOR EACH ROW EXECUTE FUNCTION calendar.tb_bump();
CREATE TABLE IF NOT EXISTS calendar.time_block_tombstones (
    id UUID PRIMARY KEY, owner_id UUID NOT NULL, change_seq BIGINT NOT NULL, deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW());
CREATE INDEX IF NOT EXISTS idx_tb_tomb ON calendar.time_block_tombstones(owner_id, change_seq);
CREATE OR REPLACE FUNCTION calendar.tb_tombstone() RETURNS trigger AS $$
BEGIN
    INSERT INTO calendar.time_block_tombstones (id, owner_id, change_seq)
    VALUES (OLD.id, OLD.owner_id, nextval('calendar.tb_change_seq'))
    ON CONFLICT (id) DO UPDATE SET change_seq = EXCLUDED.change_seq, deleted_at = NOW();
    RETURN OLD; END;$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_tb_tombstone ON calendar.time_blocks;
CREATE TRIGGER trg_tb_tombstone AFTER DELETE ON calendar.time_blocks FOR EACH ROW EXECUTE FUNCTION calendar.tb_tombstone();
