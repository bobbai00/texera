-- A chat chooses how its agent works (the agent, its model, its add-ons), not where executions
-- run: an execution started in a chat goes where any other does, to the unit the call names,
-- else the workflow's, the project's or the platform's default. The unit chats chose goes.
UPDATE resource SET spec = spec - 'computingUnit'
WHERE kind = 'conversation' AND spec ? 'computingUnit';
