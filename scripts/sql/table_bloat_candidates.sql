-- Quick table health overview for staging baselines.
SELECT schemaname,
       relname AS table_name,
       n_live_tup,
       n_dead_tup,
       last_vacuum,
       last_autovacuum,
       last_analyze,
       last_autoanalyze
  FROM pg_stat_user_tables
 ORDER BY n_dead_tup DESC
 LIMIT 30;
