-- 000004_calendar_weather.up.sql

CREATE TABLE IF NOT EXISTS weather_locations (
    id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id     UUID NOT NULL,
    name        VARCHAR(255) NOT NULL,
    latitude    DOUBLE PRECISION NOT NULL,
    longitude   DOUBLE PRECISION NOT NULL,
    timezone    VARCHAR(100) NOT NULL DEFAULT 'UTC',
    is_default  BOOLEAN NOT NULL DEFAULT FALSE,
    sort_order  INTEGER NOT NULL DEFAULT 0,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_calendar_wl_user ON weather_locations(user_id);
