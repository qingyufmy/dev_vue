-- Append-only migration source; runtime must not create this table.
CREATE TABLE account_daily_risk_baselines (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  ownership_interval_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  business_date DATE NOT NULL,
  day_start_equity DECIMAL(24,8) NOT NULL,
  equity_high_water DECIMAL(24,8) NOT NULL,
  net_capital_flow DECIMAL(24,8) NOT NULL,
  daily_loss_percent DECIMAL(12,6) NOT NULL,
  drawdown_percent DECIMAL(12,6) NOT NULL,
  source_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (trading_account_id, ownership_interval_id, business_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
