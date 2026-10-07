-- Restore the sequence + trigger delta machinery of 000006 and drop the journal
-- counter. (The tombstone tables were never dropped, so they are reused as-is.)

DROP TABLE IF EXISTS calendar.change_counter;

-- calendars
CREATE SEQUENCE IF NOT EXISTS calendar.cal_change_seq;
ALTER TABLE calendar.calendars ALTER COLUMN change_seq SET DEFAULT nextval('calendar.cal_change_seq');
CREATE OR REPLACE FUNCTION calendar.cal_bump() RETURNS trigger AS $$
BEGIN NEW.change_seq := nextval('calendar.cal_change_seq'); RETURN NEW; END;$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_cal_bump BEFORE UPDATE ON calendar.calendars FOR EACH ROW EXECUTE FUNCTION calendar.cal_bump();
CREATE OR REPLACE FUNCTION calendar.cal_tombstone() RETURNS trigger AS $$
BEGIN
    INSERT INTO calendar.calendar_tombstones (id, owner_id, change_seq)
    VALUES (OLD.id, OLD.owner_id, nextval('calendar.cal_change_seq'))
    ON CONFLICT (id) DO UPDATE SET change_seq = EXCLUDED.change_seq, deleted_at = NOW();
    RETURN OLD; END;$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_cal_tombstone AFTER DELETE ON calendar.calendars FOR EACH ROW EXECUTE FUNCTION calendar.cal_tombstone();

-- events
CREATE SEQUENCE IF NOT EXISTS calendar.ev_change_seq;
ALTER TABLE calendar.events ALTER COLUMN change_seq SET DEFAULT nextval('calendar.ev_change_seq');
CREATE OR REPLACE FUNCTION calendar.ev_bump() RETURNS trigger AS $$
BEGIN NEW.change_seq := nextval('calendar.ev_change_seq'); RETURN NEW; END;$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_ev_bump BEFORE UPDATE ON calendar.events FOR EACH ROW EXECUTE FUNCTION calendar.ev_bump();
CREATE OR REPLACE FUNCTION calendar.ev_tombstone() RETURNS trigger AS $$
BEGIN
    INSERT INTO calendar.event_tombstones (id, owner_id, change_seq)
    VALUES (OLD.id, OLD.owner_id, nextval('calendar.ev_change_seq'))
    ON CONFLICT (id) DO UPDATE SET change_seq = EXCLUDED.change_seq, deleted_at = NOW();
    RETURN OLD; END;$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_ev_tombstone AFTER DELETE ON calendar.events FOR EACH ROW EXECUTE FUNCTION calendar.ev_tombstone();
CREATE OR REPLACE FUNCTION calendar.att_bump_event() RETURNS trigger AS $$
BEGIN
    UPDATE calendar.events SET change_seq = change_seq WHERE id = COALESCE(NEW.event_id, OLD.event_id);
    RETURN COALESCE(NEW, OLD); END;$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_att_bump AFTER INSERT OR UPDATE OR DELETE ON calendar.attendees FOR EACH ROW EXECUTE FUNCTION calendar.att_bump_event();

-- time_blocks
CREATE SEQUENCE IF NOT EXISTS calendar.tb_change_seq;
ALTER TABLE calendar.time_blocks ALTER COLUMN change_seq SET DEFAULT nextval('calendar.tb_change_seq');
CREATE OR REPLACE FUNCTION calendar.tb_bump() RETURNS trigger AS $$
BEGIN NEW.change_seq := nextval('calendar.tb_change_seq'); RETURN NEW; END;$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_tb_bump BEFORE UPDATE ON calendar.time_blocks FOR EACH ROW EXECUTE FUNCTION calendar.tb_bump();
CREATE OR REPLACE FUNCTION calendar.tb_tombstone() RETURNS trigger AS $$
BEGIN
    INSERT INTO calendar.time_block_tombstones (id, owner_id, change_seq)
    VALUES (OLD.id, OLD.owner_id, nextval('calendar.tb_change_seq'))
    ON CONFLICT (id) DO UPDATE SET change_seq = EXCLUDED.change_seq, deleted_at = NOW();
    RETURN OLD; END;$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_tb_tombstone AFTER DELETE ON calendar.time_blocks FOR EACH ROW EXECUTE FUNCTION calendar.tb_tombstone();
