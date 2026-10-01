-- Back to PostgreSQL array columns.

ALTER TABLE calendar.time_blocks ALTER COLUMN days DROP DEFAULT;
ALTER TABLE calendar.time_blocks ALTER COLUMN days TYPE integer[]
    USING ARRAY(SELECT jsonb_array_elements_text(days)::int);
ALTER TABLE calendar.time_blocks ALTER COLUMN days SET DEFAULT '{}';

ALTER TABLE calendar.events ALTER COLUMN linked_task_ids DROP DEFAULT;
ALTER TABLE calendar.events ALTER COLUMN linked_task_ids TYPE uuid[]
    USING ARRAY(SELECT jsonb_array_elements_text(linked_task_ids)::uuid);
ALTER TABLE calendar.events ALTER COLUMN linked_task_ids SET DEFAULT '{}';

ALTER TABLE calendar.events ALTER COLUMN linked_file_ids DROP DEFAULT;
ALTER TABLE calendar.events ALTER COLUMN linked_file_ids TYPE uuid[]
    USING ARRAY(SELECT jsonb_array_elements_text(linked_file_ids)::uuid);
ALTER TABLE calendar.events ALTER COLUMN linked_file_ids SET DEFAULT '{}';

ALTER TABLE calendar.events ALTER COLUMN exdates DROP DEFAULT;
ALTER TABLE calendar.events ALTER COLUMN exdates TYPE timestamptz[]
    USING ARRAY(SELECT jsonb_array_elements_text(exdates)::timestamptz);
ALTER TABLE calendar.events ALTER COLUMN exdates SET DEFAULT '{}';
