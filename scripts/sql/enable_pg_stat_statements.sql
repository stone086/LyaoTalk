-- Enable query statistics for performance baselines.
-- Requires shared_preload_libraries='pg_stat_statements' and a PostgreSQL restart
-- if it is not already loaded.
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
