WITH a AS (
  SELECT lower(ClientIP) AS ip, {{FIELDS}}
  FROM http_requests
  WHERE ClientRequestHost IN ({{HOSTS}}) AND ({{WHERE}})
),
b AS (
  SELECT *, regexp_replace(ip, '(^|:)0+([0-9a-f])', '\1\2', 'g') AS n FROM a
)
SELECT {{FIELDS}},
  CASE
    WHEN regexp_like(ip, '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$') THEN regexp_replace(ip, '^([0-9]+)\.([0-9]+)\.([0-9]+)\.[0-9]+$', '\1.\2.\3.0/24')
    WHEN regexp_like(n, '^[0-9a-f]{1,4}:[0-9a-f]{1,4}:[0-9a-f]{1,4}:') THEN regexp_replace(n, '^([0-9a-f]{1,4}):([0-9a-f]{1,4}):([0-9a-f]{1,4}):.*$', '\1:\2:\3::/48')
    WHEN regexp_like(n, '^[0-9a-f]{1,4}:[0-9a-f]{1,4}::') THEN regexp_replace(n, '^([0-9a-f]{1,4}):([0-9a-f]{1,4})::.*$', '\1:\2:0::/48')
    WHEN regexp_like(n, '^[0-9a-f]{1,4}::') THEN regexp_replace(n, '^([0-9a-f]{1,4})::.*$', '\1:0:0::/48')
    WHEN starts_with(n, '::') THEN '0:0:0::/48'
    ELSE NULL
  END AS ClientNetwork
FROM b
