-- People edit a workflow together in a live session. The version a session saves names
-- everyone whose edits it holds; one person's edits need no list, the creator says it all.
ALTER TABLE resource_version ADD COLUMN contributors uuid[];

-- The live document of a resource: the working copy of the live service, kept beside the
-- resource between sessions so the same document continues. The versions stay the truth;
-- based_on is the version the document was last saved as.
CREATE TABLE live_state (
    rid         uuid PRIMARY KEY REFERENCES resource (rid),
    based_on    integer,
    state       bytea NOT NULL,
    updated_at  timestamptz NOT NULL DEFAULT now()
);
