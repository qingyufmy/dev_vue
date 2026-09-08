-- Incremental projection dependencies after completed 037. No legacy facts seeded.
-- market_candles requires a separate preserve/map/promote migration.
CREATE TABLE `account_runtime_snapshots` (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  balance DECIMAL(24,8) NOT NULL,
  equity DECIMAL(24,8) NOT NULL,
  margin_amount DECIMAL(24,8) NOT NULL,
  free_margin DECIMAL(24,8) NOT NULL,
  floating_profit DECIMAL(24,8) NOT NULL,
  leverage INT UNSIGNED NULL,
  timezone_offset_minutes SMALLINT NULL,
  clock_status ENUM('calibrated','observer_bootstrap','stale','unavailable') NOT NULL,
  trade_permission TINYINT(1) NOT NULL DEFAULT 0,
  observed_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (trading_account_id),
  KEY idx_account_snapshot_observed (observed_at_utc),
  CONSTRAINT fk_account_snapshot_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `market_quotes` (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bid DECIMAL(24,10) NOT NULL,
  ask DECIMAL(24,10) NOT NULL,
  last_price DECIMAL(24,10) NULL,
  spread DECIMAL(24,10) NOT NULL,
  trade_mode ENUM('full','long_only','short_only','close_only','disabled','unknown') NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (trading_account_id, symbol),
  KEY idx_market_quotes_observed (observed_at_utc),
  CONSTRAINT fk_market_quotes_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `open_position_snapshots` (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  ticket VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_json JSON NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (trading_account_id, ticket),
  KEY idx_open_positions_revision (trading_account_id, revision),
  CONSTRAINT fk_open_positions_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `pending_order_snapshots` (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  ticket VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_json JSON NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (trading_account_id, ticket),
  KEY idx_pending_orders_revision (trading_account_id, revision),
  CONSTRAINT fk_pending_orders_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `trading_projection_revisions` (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  resource_kind VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (trading_account_id, resource_kind, resource_id),
  CONSTRAINT fk_projection_revisions_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `trading_projection_provenance_v4` (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  resource_kind VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  ownership_interval_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  ownership_revision BIGINT UNSIGNED NOT NULL,
  terminal_profile_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  terminal_instance_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  connection_epoch BIGINT UNSIGNED NOT NULL,
  projection_revision BIGINT UNSIGNED NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (trading_account_id, resource_kind, resource_id),
  KEY idx_projection_provenance_interval (ownership_interval_id),
  CONSTRAINT fk_projection_provenance_revision FOREIGN KEY (trading_account_id, resource_kind, resource_id)
    REFERENCES trading_projection_revisions (trading_account_id, resource_kind, resource_id),
  CONSTRAINT fk_projection_provenance_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_projection_provenance_interval FOREIGN KEY (ownership_interval_id) REFERENCES trading_account_ownership_intervals (id),
  CONSTRAINT fk_projection_provenance_profile FOREIGN KEY (terminal_profile_id) REFERENCES terminal_profiles (id),
  CONSTRAINT chk_projection_provenance_kind CHECK (resource_kind IN ('account.metrics','positions','pending_orders'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
