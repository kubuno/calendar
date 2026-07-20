-- 000008_appointment_schedules.down.sql
DROP TABLE IF EXISTS calendar.appointment_bookings;
DROP TABLE IF EXISTS calendar.appointment_availability;
DROP TRIGGER IF EXISTS appointment_schedules_updated_at ON calendar.appointment_schedules;
DROP FUNCTION IF EXISTS calendar.set_as_updated_at();
DROP TABLE IF EXISTS calendar.appointment_schedules;
