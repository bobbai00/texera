-- Environments become profiles. A profile is what a computing node is made of: its size and
-- the Python packages it adds to the platform's runtime; a unit is made from one and installs
-- its packages itself. What chose an environment per run (a workflow's, a project's, the
-- settings' default, a chat's choice, a custom operator's pin) has no meaning left and goes.

-- An environment's packages are its profile's packages.
UPDATE resource
SET kind = 'profile',
    spec = jsonb_strip_nulls(jsonb_build_object('packages', spec -> 'python' -> 'packages')),
    status = NULL
WHERE kind = 'environment';

UPDATE resource_version v
SET content = jsonb_strip_nulls(jsonb_build_object('packages', v.content -> 'python' -> 'packages'))
FROM resource r
WHERE v.rid = r.rid AND r.kind = 'profile' AND v.content ? 'python';

-- What named an environment.
UPDATE resource SET spec = spec - 'defaultEnvironment'
WHERE kind IN ('workflow', 'project') AND spec ? 'defaultEnvironment';
UPDATE resource SET spec = spec #- '{defaults,environment}'
WHERE kind = 'settings' AND spec -> 'defaults' ? 'environment';
UPDATE resource SET spec = spec - 'environment'
WHERE kind = 'conversation' AND spec ? 'environment';
UPDATE resource SET spec = spec #- '{implementation,python,environment}'
WHERE kind = 'operator' AND spec -> 'implementation' -> 'python' ? 'environment';
UPDATE resource SET status = status - 'environments'
WHERE kind = 'computing-unit' AND status ? 'environments';

-- A reference to an environment is one to the profile it became.
UPDATE edge SET from_uri = replace(from_uri, 'texera://environments/', 'texera://profiles/')
WHERE from_uri LIKE 'texera://environments/%';
UPDATE edge SET to_uri = replace(to_uri, 'texera://environments/', 'texera://profiles/')
WHERE to_uri LIKE 'texera://environments/%';
