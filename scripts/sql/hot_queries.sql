-- Requires pg_stat_statements.
SELECT calls,
       round(mean_exec_time::numeric, 2) AS mean_ms,
       round(total_exec_time::numeric, 2) AS total_ms,
       rows,
       left(regexp_replace(query, '\s+', ' ', 'g'), 220) AS query_preview
  FROM pg_stat_statements
 ORDER BY total_exec_time DESC
 LIMIT 20;
