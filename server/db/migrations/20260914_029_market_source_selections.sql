-- Additive metadata only. Existing account market data retains its provenance.
CREATE TABLE IF NOT EXISTS market_source_selections (
  pool_key VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  standard_symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  source_generation BIGINT UNSIGNED NOT NULL,
  state_json JSON NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (pool_key, standard_symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
