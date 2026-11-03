-- Texera 2.0 catalog schema: one envelope (resource + version + principal + grant) for every
-- kind, executions with port-level lineage, conversations as resources with append-only
-- messages, agents as principals.

CREATE TABLE principal (
    pid              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind             text NOT NULL CHECK (kind IN ('user', 'agent', 'group')),
    display_name     text NOT NULL,
    -- OIDC subject for users and service accounts; NULL for agents and groups.
    subject          text UNIQUE,
    email            text,
    sponsor_pid      uuid REFERENCES principal (pid),
    created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE resource (
    rid                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    kind                    text NOT NULL,
    name                    text NOT NULL,
    description             text,
    -- The containing project; NULL only for a top-level project.
    parent_rid              uuid REFERENCES resource (rid),
    visibility              text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
    labels                  jsonb NOT NULL DEFAULT '{}'::jsonb,
    spec                    jsonb NOT NULL DEFAULT '{}'::jsonb,
    status                  jsonb,
    head_vno                integer NOT NULL DEFAULT 0,
    owner_pid               uuid NOT NULL REFERENCES principal (pid),
    created_by_pid          uuid NOT NULL REFERENCES principal (pid),
    on_behalf_of_pid        uuid REFERENCES principal (pid),
    origin_conversation_rid uuid REFERENCES resource (rid),
    origin_seq              bigint,
    created_at              timestamptz NOT NULL DEFAULT now(),
    updated_at              timestamptz NOT NULL DEFAULT now(),
    deleted_at              timestamptz,
    search                  tsvector GENERATED ALWAYS AS (
        to_tsvector('simple', coalesce(name, '') || ' ' || coalesce(description, ''))
    ) STORED
);
CREATE INDEX resource_kind_idx ON resource (kind) WHERE deleted_at IS NULL;
CREATE INDEX resource_parent_idx ON resource (parent_rid);
CREATE INDEX resource_owner_idx ON resource (owner_pid);
CREATE INDEX resource_origin_idx ON resource (origin_conversation_rid);
CREATE INDEX resource_search_idx ON resource USING gin (search);

CREATE TABLE resource_version (
    rid                     uuid NOT NULL REFERENCES resource (rid),
    vno                     integer NOT NULL,
    content_kind            text NOT NULL CHECK (content_kind IN ('json', 'manifest', 'oci_digest', 'checkpoint')),
    content_ref             text,
    content                 jsonb,
    message                 text,
    created_by_pid          uuid NOT NULL REFERENCES principal (pid),
    on_behalf_of_pid        uuid REFERENCES principal (pid),
    origin_conversation_rid uuid REFERENCES resource (rid),
    origin_seq              bigint,
    created_at              timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rid, vno)
);

-- Grants are the source of truth; the outbox mirrors them into OpenFGA tuples.
CREATE TABLE access_grant (
    rid         uuid NOT NULL REFERENCES resource (rid),
    pid         uuid NOT NULL REFERENCES principal (pid),
    relation    text NOT NULL CHECK (relation IN ('owner', 'editor', 'viewer')),
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rid, pid)
);

CREATE TABLE access_outbox (
    id           bigserial PRIMARY KEY,
    op           text NOT NULL CHECK (op IN ('write', 'delete')),
    object       text NOT NULL,
    relation     text NOT NULL,
    subject      text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    processed_at timestamptz
);
CREATE INDEX access_outbox_pending_idx ON access_outbox (id) WHERE processed_at IS NULL;

CREATE TABLE message (
    conversation_rid  uuid NOT NULL REFERENCES resource (rid),
    seq               bigint NOT NULL,
    role              text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
    author_pid        uuid NOT NULL REFERENCES principal (pid),
    on_behalf_of_pid  uuid REFERENCES principal (pid),
    parts             jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at        timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (conversation_rid, seq)
);

CREATE TABLE agent (
    pid              uuid PRIMARY KEY REFERENCES principal (pid),
    template_rid     uuid NOT NULL REFERENCES resource (rid),
    template_vno     integer NOT NULL,
    spawned_by_pid   uuid REFERENCES principal (pid),
    conversation_rid uuid REFERENCES resource (rid),
    eid              uuid,
    opid             text,
    lifetime         text NOT NULL DEFAULT 'conversation' CHECK (lifetime IN ('execution', 'conversation', 'pinned')),
    status           text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
    created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_conversation_idx ON agent (conversation_rid);

CREATE TABLE execution (
    eid                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name                    text,
    workflow_rid            uuid NOT NULL REFERENCES resource (rid),
    workflow_vno            integer NOT NULL,
    env_rid                 uuid REFERENCES resource (rid),
    env_vno                 integer,
    cu_rid                  uuid NOT NULL REFERENCES resource (rid),
    actor_pid               uuid NOT NULL REFERENCES principal (pid),
    on_behalf_of_pid        uuid REFERENCES principal (pid),
    origin_conversation_rid uuid REFERENCES resource (rid),
    origin_seq              bigint,
    parameters              jsonb,
    status                  text NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    error                   jsonb,
    -- Per-operator run state as reported by the unit: {opid: {state, tuples, error}}.
    operators               jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at              timestamptz NOT NULL DEFAULT now(),
    started_at              timestamptz,
    finished_at             timestamptz
);
CREATE INDEX execution_workflow_idx ON execution (workflow_rid, created_at DESC);
CREATE INDEX execution_origin_idx ON execution (origin_conversation_rid);

-- Dataset and model versions an execution read, pinned at start.
CREATE TABLE execution_input (
    eid  uuid NOT NULL REFERENCES execution (eid),
    rid  uuid NOT NULL REFERENCES resource (rid),
    vno  integer NOT NULL,
    PRIMARY KEY (eid, rid, vno)
);

-- One Iceberg table per (execution, operator instance, output port).
CREATE TABLE port_result (
    eid          uuid NOT NULL REFERENCES execution (eid),
    opid         text NOT NULL,
    port         text NOT NULL,
    table_id     text,
    snapshot_id  text,
    tuple_count  bigint,
    bytes        bigint,
    hash         text,
    PRIMARY KEY (eid, opid, port)
);

-- consumes: from_eid differs from eid when a result was reused by hash.
CREATE TABLE port_edge (
    eid        uuid NOT NULL REFERENCES execution (eid),
    opid       text NOT NULL,
    port       text NOT NULL,
    from_eid   uuid NOT NULL,
    from_opid  text NOT NULL,
    from_port  text NOT NULL,
    PRIMARY KEY (eid, opid, port, from_eid, from_opid, from_port)
);

-- A source port and the dataset version file it read.
CREATE TABLE port_input (
    eid   uuid NOT NULL REFERENCES execution (eid),
    opid  text NOT NULL,
    port  text NOT NULL,
    rid   uuid NOT NULL REFERENCES resource (rid),
    vno   integer NOT NULL,
    path  text NOT NULL DEFAULT '',
    PRIMARY KEY (eid, opid, port, rid, vno, path)
);

-- The roll-up of port lineage to resource versions.
CREATE TABLE version_edge (
    from_rid  uuid NOT NULL,
    from_vno  integer NOT NULL,
    to_rid    uuid NOT NULL,
    to_vno    integer NOT NULL,
    kind      text NOT NULL CHECK (kind IN ('derived', 'read', 'produced')),
    eid       uuid,
    PRIMARY KEY (from_rid, from_vno, to_rid, to_vno, kind)
);
CREATE INDEX version_edge_to_idx ON version_edge (to_rid, to_vno);

-- Files uploaded to a dataset but not yet committed as a version.
CREATE TABLE dataset_staging (
    rid           uuid NOT NULL REFERENCES resource (rid),
    path          text NOT NULL,
    size          bigint NOT NULL,
    sha256        text,
    content_type  text,
    object_key    text NOT NULL,
    uploaded_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (rid, path)
);

-- Raw OpenLineage events as received, for audit and replay.
CREATE TABLE lineage_event (
    id           bigserial PRIMARY KEY,
    eid          uuid,
    received_at  timestamptz NOT NULL DEFAULT now(),
    body         jsonb NOT NULL
);
CREATE INDEX lineage_event_eid_idx ON lineage_event (eid);
