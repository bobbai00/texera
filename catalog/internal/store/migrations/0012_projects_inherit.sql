-- Projects inherit from one another. Every project but Texera, the root, has a base: the project
-- it inherits from, whose resources its people read and use and whose settings fill in what its
-- own leave out. What was built in is what Texera holds, and Texera is a project like any other,
-- changed by its admins. What were the deployment's settings are each project's own.

ALTER TABLE resource ADD COLUMN base_rid uuid REFERENCES resource (rid);
CREATE INDEX resource_base_idx ON resource (base_rid) WHERE base_rid IS NOT NULL AND deleted_at IS NULL;

-- The platform's project is Texera, the root of every chain.
UPDATE resource
SET name = 'Texera',
    description = 'Texera itself, which every project inherits from: the agent and its skills, the engine''s operators, the profiles, the computing unit and the warehouse of this deployment. Its settings are every project''s unless the project sets its own.',
    labels = (labels - 'texera.system') || '{"texera.root": "true"}'::jsonb
WHERE kind = 'project' AND labels ->> 'texera.system' = 'true';

-- Every other project inherits from it. A link to Texera needs no tuple: Texera is open to
-- everyone, so the link gives nobody more than they have.
UPDATE resource p
SET base_rid = root.rid
FROM resource root
WHERE root.kind = 'project' AND root.labels ->> 'texera.root' = 'true' AND root.deleted_at IS NULL
  AND p.kind = 'project' AND p.rid <> root.rid AND p.base_rid IS NULL;

-- A project's defaults move under `defaults`, beside its branding and limits.
UPDATE resource
SET spec = jsonb_strip_nulls(jsonb_build_object('defaults', NULLIF(jsonb_strip_nulls(jsonb_build_object(
        'computingUnit', spec -> 'defaultComputingUnit',
        'warehouse', spec -> 'defaultWarehouse',
        'agentTemplate', spec -> 'defaultAgentTemplate',
        'modelEndpoint', spec -> 'defaultModelEndpoint',
        'mcpServers', spec -> 'mcpServers',
        'workMode', spec -> 'defaultWorkMode')), '{}'::jsonb)))
WHERE kind = 'project';
UPDATE edge
SET field = CASE field
        WHEN '/defaultComputingUnit' THEN '/defaults/computingUnit'
        WHEN '/defaultWarehouse' THEN '/defaults/warehouse'
        WHEN '/defaultAgentTemplate' THEN '/defaults/agentTemplate'
        WHEN '/defaultModelEndpoint' THEN '/defaults/modelEndpoint'
        ELSE regexp_replace(field, '^/mcpServers/', '/defaults/mcpServers/')
    END
WHERE relation = 'references' AND from_uri LIKE 'texera://projects/%';

-- The deployment's settings are Texera's now: the catalog fills them in at its next start.
DELETE FROM edge WHERE from_uri = 'texera://settings';
DELETE FROM resource_version WHERE rid IN (SELECT rid FROM resource WHERE kind = 'settings');
DELETE FROM access_index WHERE rid IN (SELECT rid FROM resource WHERE kind = 'settings');
DELETE FROM resource WHERE kind = 'settings';

-- An administrator is one of Texera's admins, not a flag that passes every check.
WITH added AS (
    INSERT INTO access_index (rid, pid, relation)
    SELECT root.rid, p.pid, 'owner'
    FROM principal p, resource root
    WHERE p.admin AND p.kind = 'user' AND root.kind = 'project' AND root.labels ->> 'texera.root' = 'true' AND root.deleted_at IS NULL
    ON CONFLICT (rid, pid) DO NOTHING
    RETURNING rid, pid
)
INSERT INTO access_outbox (op, object, relation, subject)
SELECT 'write', 'resource:' || rid, 'owner', 'user:' || pid FROM added;
ALTER TABLE principal DROP COLUMN admin;

-- What a release put into Texera, by kind and the name it ships it under, with the digest of the
-- spec it wrote: a later release updates a resource only while its spec is still that one, and
-- does not bring back one an admin deleted.
CREATE TABLE shipped (
    kind    text NOT NULL,
    name    text NOT NULL,
    rid     uuid NOT NULL,
    digest  text NOT NULL,
    PRIMARY KEY (kind, name)
);
