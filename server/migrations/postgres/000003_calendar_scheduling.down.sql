-- 000003_calendar_scheduling.down.sql
DROP MATERIALIZED VIEW IF EXISTS calendar.analytics_cache;
DROP TABLE IF EXISTS calendar.poll_responses;
DROP TABLE IF EXISTS calendar.poll_slots;
DROP TABLE IF EXISTS calendar.meeting_polls;
