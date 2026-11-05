-- A built-in is a resource in the platform's project, and nothing on the resource says so: it
-- is everyone's through that project. What an earlier release seeded was public and labelled
-- one by one; this brings it to the state of a fresh seed. The tuples that made each one
-- public go through the outbox like any other change.
INSERT INTO access_outbox (op, object, relation, subject)
SELECT 'delete', 'resource:' || r.rid, 'viewer', 'user:*'
FROM resource r
JOIN resource p ON p.rid = r.project_rid
WHERE p.kind = 'project' AND p.labels ->> 'texera.system' = 'true' AND r.rid <> p.rid AND r.visibility = 'public';

UPDATE resource r
SET visibility = 'private',
    labels = r.labels - 'texera.builtin',
    status = CASE WHEN r.kind = 'operator' THEN r.status - 'builtin' ELSE r.status END
FROM resource p
WHERE p.rid = r.project_rid AND p.kind = 'project' AND p.labels ->> 'texera.system' = 'true' AND r.rid <> p.rid;
