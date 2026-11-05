-- What wrote an assistant message besides the template version: the model endpoint, and the
-- MCP servers its turn mounted. A chat's settings can change between turns, so each answer
-- keeps its own.
ALTER TABLE message ADD COLUMN model_endpoint_uri text;
ALTER TABLE message ADD COLUMN mcp_server_uris text[];
