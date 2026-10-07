-- Remote iCalendar subscriptions: a calendar with cal_type = 'subscription'
-- mirrors an external .ics feed. The URL is fetched at creation, on manual
-- refresh, and periodically by a background task.
ALTER TABLE calendar.calendars ADD COLUMN IF NOT EXISTS subscription_url TEXT;
ALTER TABLE calendar.calendars ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;
