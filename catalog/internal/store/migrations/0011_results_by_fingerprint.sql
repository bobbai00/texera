-- A port's stored rows are found again by the fingerprint of the work that made them: the
-- produced arrow from a port to its table carries it, and a run looks there before it makes
-- the rows again.
CREATE INDEX IF NOT EXISTS edge_produced_fingerprint_idx ON edge ((attrs->>'fingerprint')) WHERE relation = 'produced';
