-- What a chat made is found by the chat: the versions it made, as the resources it created
-- already are (resource_origin_idx).
CREATE INDEX resource_version_origin_idx ON resource_version ((origin ->> 'conversation')) WHERE origin IS NOT NULL;
