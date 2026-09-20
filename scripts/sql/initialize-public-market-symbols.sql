-- Configuration initialization, not a schema migration. Execute only with authorization.
-- Existing administrator configuration is preserved.
INSERT INTO system_settings
  (namespace, setting_key, value_type, value_text, sensitivity, label, sort_order,
   created_at_utc, updated_at_utc, revision, origin)
SELECT 'market_data', 'symbols', 'json_array', '["XAUUSD"]', 'restricted',
  '公共行情基础品种', 0, UTC_TIMESTAMP(3), UTC_TIMESTAMP(3), 1, 'native'
WHERE NOT EXISTS (
  SELECT 1 FROM system_settings WHERE namespace = 'market_data' AND setting_key = 'symbols'
);
