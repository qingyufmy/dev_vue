-- Append-only build area. The legacy market_candles remains unchanged.
CREATE TABLE `legacy_candle_backfill_v4` (
  id TINYINT UNSIGNED NOT NULL,
  conversion_plan_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_plan_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_rows_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  mapping_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  projection_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expected_source_rows BIGINT UNSIGNED NOT NULL,
  expected_projection_rows BIGINT UNSIGNED NOT NULL,
  mapped_rows BIGINT UNSIGNED NOT NULL DEFAULT 0,
  projection_rows BIGINT UNSIGNED NOT NULL DEFAULT 0,
  last_legacy_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('filling','verified') NOT NULL DEFAULT 'filling',
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_legacy_candle_plan (conversion_plan_hash),
  CONSTRAINT chk_legacy_candle_single_run CHECK (id = 1),
  CONSTRAINT chk_legacy_candle_counts CHECK (
    expected_projection_rows <= expected_source_rows AND mapped_rows <= expected_source_rows
    AND projection_rows <= expected_projection_rows AND projection_rows <= mapped_rows),
  CONSTRAINT chk_legacy_candle_verified CHECK (
    status <> 'verified' OR (mapped_rows = expected_source_rows AND projection_rows = expected_projection_rows))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `market_candles_build_v4` (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  timeframe ENUM('M1','M5','M15','M30','H1','H4','D1') NOT NULL,
  open_time_utc DATETIME(3) NOT NULL,
  open_price DECIMAL(24,10) NOT NULL,
  high_price DECIMAL(24,10) NOT NULL,
  low_price DECIMAL(24,10) NOT NULL,
  close_price DECIMAL(24,10) NOT NULL,
  tick_volume DECIMAL(24,8) NOT NULL,
  closed TINYINT(1) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (trading_account_id, symbol, timeframe, open_time_utc),
  KEY idx_market_candles_tail (trading_account_id, symbol, timeframe, open_time_utc DESC),
  CONSTRAINT fk_market_candles_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `legacy_candle_mappings_v4` (
  legacy_candle_id BIGINT UNSIGNED NOT NULL,
  run_id TINYINT UNSIGNED NOT NULL,
  source_id BIGINT UNSIGNED NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  timeframe ENUM('M1','M5','M15','M30','H1','H4','D1') NOT NULL,
  open_time_utc DATETIME(3) NOT NULL,
  target_key_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (legacy_candle_id),
  KEY idx_legacy_candle_target (trading_account_id, symbol, timeframe, open_time_utc),
  CONSTRAINT fk_legacy_candle_run FOREIGN KEY (run_id) REFERENCES legacy_candle_backfill_v4 (id),
  CONSTRAINT fk_legacy_candle_original FOREIGN KEY (legacy_candle_id) REFERENCES market_candles (id),
  CONSTRAINT fk_legacy_candle_source FOREIGN KEY (source_id) REFERENCES market_data_sources (id),
  CONSTRAINT fk_legacy_candle_target FOREIGN KEY (trading_account_id, symbol, timeframe, open_time_utc)
    REFERENCES market_candles_build_v4 (trading_account_id, symbol, timeframe, open_time_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
