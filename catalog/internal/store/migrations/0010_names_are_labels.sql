-- A name is a label people read; a resource is told apart by its rid, which every URI, route
-- and reference uses. Two workflows (or datasets, chats, executions...) in one project may
-- have the same name, as two files in a folder of a drive may. The index that refused a
-- second one goes; one that finds resources by name in a place stays (the seed looks up the
-- platform's own built-ins that way, in the project only the platform writes to).
DROP INDEX IF EXISTS resource_name_idx;
CREATE INDEX IF NOT EXISTS resource_name_lookup_idx ON resource (coalesce(parent_rid, owner_pid), kind, lower(name)) WHERE deleted_at IS NULL;
