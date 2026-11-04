-- Texera 2.0 catalog schema. One `resource` table carries every kind (the envelope: metadata,
-- spec, status); `resource_version` holds the immutable snapshots; `edge` is the one table of
-- references and lineage, an index rebuilt from versions and events; grants live in OpenFGA,
-- mirrored here as a search index and relayed through the outbox; secrets never land here.

CREATE TABLE principal (
    pid           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind          text NOT NULL CHECK (kind IN ('user', 'group')),
    display_name  text NOT NULL,
    -- The OIDC subject of a user; NULL for a group.
    subject       text UNIQUE,
    email         text,
    admin         boolean NOT NULL DEFAULT false,
    preferences   jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX principal_search_idx ON principal (lower(display_name), lower(coalesce(email, '')));

CREATE TABLE resource (
    rid             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind            text NOT NULL,
    name            text NOT NULL,
    description     text,
    -- The immediate parent: a project for a top-level kind, the workflow for an execution;
    -- NULL for a project and the settings singleton.
    parent_rid      uuid REFERENCES resource (rid),
    -- The nearest project; the resource itself for a project.
    project_rid     uuid REFERENCES resource (rid),
    owner_pid       uuid NOT NULL REFERENCES principal (pid),
    visibility      text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
    labels          jsonb NOT NULL DEFAULT '{}'::jsonb,
    spec            jsonb NOT NULL DEFAULT '{}'::jsonb,
    status          jsonb,
    -- The newest version number; 0 for an unversioned kind.
    head_vno        integer NOT NULL DEFAULT 0,
    -- Changes on every write; If-Match refuses lost updates.
    etag            text NOT NULL,
    created_by_pid  uuid NOT NULL REFERENCES principal (pid),
    -- {conversation, turn, template}: the chat turn that made it.
    origin          jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    updated_at      timestamptz NOT NULL DEFAULT now(),
    deleted_at      timestamptz,
    search          tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, ''))
    ) STORED
);
CREATE INDEX resource_kind_idx ON resource (kind, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX resource_parent_idx ON resource (parent_rid) WHERE deleted_at IS NULL;
CREATE INDEX resource_project_idx ON resource (project_rid) WHERE deleted_at IS NULL;
CREATE INDEX resource_owner_idx ON resource (owner_pid) WHERE deleted_at IS NULL;
CREATE INDEX resource_origin_idx ON resource ((origin ->> 'conversation')) WHERE origin IS NOT NULL;
CREATE INDEX resource_search_idx ON resource USING gin (search);
-- Names are unique per parent and kind among live resources; a root resource per owner.
CREATE UNIQUE INDEX resource_name_idx ON resource (coalesce(parent_rid, owner_pid), kind, lower(name)) WHERE deleted_at IS NULL;

CREATE TABLE resource_version (
    rid             uuid NOT NULL REFERENCES resource (rid),
    vno             integer NOT NULL,
    content_kind    text NOT NULL CHECK (content_kind IN ('spec', 'manifest', 'table')),
    -- sha256: of the canonical JSON of the content.
    digest          text NOT NULL,
    content         jsonb NOT NULL,
    message         text,
    created_by_pid  uuid NOT NULL REFERENCES principal (pid),
    origin          jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rid, vno)
);

-- Direct grants, as a search index and for listing; decisions come from OpenFGA, which the
-- outbox feeds in the same transaction.
CREATE TABLE access_index (
    rid         uuid NOT NULL REFERENCES resource (rid),
    pid         uuid NOT NULL REFERENCES principal (pid),
    relation    text NOT NULL CHECK (relation IN ('owner', 'editor', 'viewer', 'user')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rid, pid)
);
CREATE INDEX access_index_pid_idx ON access_index (pid);

CREATE TABLE access_outbox (
    id            bigserial PRIMARY KEY,
    op            text NOT NULL CHECK (op IN ('write', 'delete')),
    object        text NOT NULL,
    relation      text NOT NULL,
    subject       text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    processed_at  timestamptz
);
CREATE INDEX access_outbox_pending_idx ON access_outbox (id) WHERE processed_at IS NULL;

-- Content-addressed files: the same bytes are stored once, under blobs/sha256/{aa}/{digest}.
CREATE TABLE blob (
    sha256        text PRIMARY KEY,
    size          bigint NOT NULL,
    content_type  text,
    created_at    timestamptz NOT NULL DEFAULT now()
);

-- Files uploaded to a dataset or model but not yet committed as a version.
CREATE TABLE dataset_staging (
    rid           uuid NOT NULL REFERENCES resource (rid),
    path          text NOT NULL,
    sha256        text NOT NULL REFERENCES blob (sha256),
    size          bigint NOT NULL,
    content_type  text,
    uploaded_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rid, path)
);

-- One arrow between two URIs: references extracted from versions, and the runtime lineage
-- (used, produced, derivedFrom, reused) from executions. Rebuildable; never the truth.
CREATE TABLE edge (
    from_uri       text NOT NULL,
    relation       text NOT NULL CHECK (relation IN ('references', 'used', 'produced', 'derivedFrom', 'reused')),
    to_uri         text NOT NULL,
    from_rid       uuid NOT NULL,
    to_rid         uuid,
    -- For references: the JSON pointer of the field that held the URI.
    field          text,
    -- For runtime relations: the execution that caused the arrow.
    execution_rid  uuid,
    attrs          jsonb,
    at             timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (from_uri, relation, to_uri)
);
CREATE INDEX edge_to_idx ON edge (to_rid, relation);
CREATE INDEX edge_from_idx ON edge (from_rid, relation);
CREATE INDEX edge_to_uri_idx ON edge (to_uri text_pattern_ops);
CREATE INDEX edge_from_uri_idx ON edge (from_uri text_pattern_ops);

-- Raw OpenLineage events as received, for audit and replay.
CREATE TABLE lineage_event (
    id             bigserial PRIMARY KEY,
    execution_rid  uuid,
    received_at    timestamptz NOT NULL DEFAULT now(),
    body           jsonb NOT NULL
);
CREATE INDEX lineage_event_execution_idx ON lineage_event (execution_rid);

-- The append-only history of a conversation; seq is assigned under the conversation's lock.
CREATE TABLE message (
    conversation_rid  uuid NOT NULL REFERENCES resource (rid),
    seq               bigint NOT NULL,
    turn              uuid,
    role              text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    -- The person whose turn it was.
    author_pid        uuid NOT NULL REFERENCES principal (pid),
    -- For an assistant message: the template version that wrote it.
    template_uri      text,
    parts             jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz,
    PRIMARY KEY (conversation_rid, seq)
);

-- Every time a credential's secret was handed out.
CREATE TABLE credential_lease (
    lease           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    credential_rid  uuid NOT NULL REFERENCES resource (rid),
    pid             uuid NOT NULL REFERENCES principal (pid),
    purpose         text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz
);
CREATE INDEX credential_lease_credential_idx ON credential_lease (credential_rid, created_at DESC);
