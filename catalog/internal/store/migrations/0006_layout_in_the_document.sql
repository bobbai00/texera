-- Where a workflow's operators sit is part of the workflow's live document, one layout for
-- everyone who has it open. The places each person kept in their own preferences are no
-- longer read by anything.
UPDATE principal SET preferences = preferences - 'canvas' WHERE preferences ? 'canvas';
