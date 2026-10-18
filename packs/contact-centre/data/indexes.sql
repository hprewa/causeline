-- Keys a warehouse would have, so the join in data.yaml does not rescan the agents table for every call.
CREATE INDEX IF NOT EXISTS ix_agents_agent ON agents(agent);
CREATE INDEX IF NOT EXISTS ix_calls_ts     ON calls(ts);
ANALYZE;
