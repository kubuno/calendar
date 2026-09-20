-- Array columns become JSON arrays, for portability across the three engines
-- (MySQL and SQLite have no array type — see kubuno-db §2.8). The Rust structs
-- read these back with `#[sqlx(json)]`.
--
--   events.exdates          TIMESTAMPTZ[] -> jsonb array of RFC3339 timestamps
--   events.linked_file_ids  UUID[]        -> jsonb array of UUID text
--   events.linked_task_ids  UUID[]        -> jsonb array of UUID text
--   time_blocks.days        INTEGER[]     -> jsonb array of integers
--
-- No GIN index ever covered these columns, so there is none to swap.

ALTER TABLE calendar.events ALTER COLUMN exdates DROP DEFAULT;
ALTER TABLE calendar.events ALTER COLUMN exdates TYPE jsonb USING to_jsonb(exdates);
ALTER TABLE calendar.events ALTER COLUMN exdates SET DEFAULT '[]'::jsonb;

ALTER TABLE calendar.events ALTER COLUMN linked_file_ids DROP DEFAULT;
ALTER TABLE calendar.events ALTER COLUMN linked_file_ids TYPE jsonb USING to_jsonb(linked_file_ids);
ALTER TABLE calendar.events ALTER COLUMN linked_file_ids SET DEFAULT '[]'::jsonb;

ALTER TABLE calendar.events ALTER COLUMN linked_task_ids DROP DEFAULT;
ALTER TABLE calendar.events ALTER COLUMN linked_task_ids TYPE jsonb USING to_jsonb(linked_task_ids);
ALTER TABLE calendar.events ALTER COLUMN linked_task_ids SET DEFAULT '[]'::jsonb;

ALTER TABLE calendar.time_blocks ALTER COLUMN days DROP DEFAULT;
ALTER TABLE calendar.time_blocks ALTER COLUMN days TYPE jsonb USING to_jsonb(days);
ALTER TABLE calendar.time_blocks ALTER COLUMN days SET DEFAULT '[]'::jsonb;
