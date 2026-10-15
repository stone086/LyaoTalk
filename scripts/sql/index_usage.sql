-- Find user indexes that appear unused since the last stats reset.
SELECT schemaname,
       relname AS table_name,
       indexrelname AS index_name,
       idx_scan,
       pg_size_pretty(pg_relation_size(indexrelid)) AS index_size
  FROM pg_stat_user_indexes
 WHERE idx_scan = 0
   AND indexrelname NOT LIKE '%_pkey%'
   AND indexrelname NOT LIKE 'uq_%'
 ORDER BY pg_relation_size(indexrelid) DESC;
