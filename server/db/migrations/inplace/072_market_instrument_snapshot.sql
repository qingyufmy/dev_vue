-- Restore the missing V4 instrument projection from canonical migration 006.
-- Additive only; live instrument facts must arrive through the normal collection path.
CREATE TABLE IF NOT EXISTS market_instrument_snapshots (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_json JSON NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (trading_account_id, symbol),
  KEY idx_market_instrument_observed (observed_at_utc),
  CONSTRAINT fk_market_instrument_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
