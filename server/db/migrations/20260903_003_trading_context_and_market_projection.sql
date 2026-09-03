-- V4 account, terminal and realtime projection schema.
-- TARGET: empty V4 side-by-side database only. Never run this file against the legacy database.
-- Application startup must never execute migrations; deployment applies this artifact explicitly after backup and dry-run reconciliation.

CREATE TABLE IF NOT EXISTS trading_accounts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  platform ENUM('mt4','mt5') NOT NULL,
  broker_server VARCHAR(191) NOT NULL,
  account_login VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  currency VARCHAR(12) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  deleted_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_trading_account_identity (platform, broker_server, account_login),
  KEY idx_trading_accounts_active (deleted_at_utc, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS trading_account_ownerships (
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  role ENUM('owner','observer_source') NOT NULL DEFAULT 'owner',
  granted_at_utc DATETIME(3) NOT NULL,
  revoked_at_utc DATETIME(3) NULL,
  PRIMARY KEY (user_id, trading_account_id, role),
  KEY idx_account_owners_account (trading_account_id, revoked_at_utc, user_id),
  CONSTRAINT fk_account_owners_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_account_owners_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS terminal_profiles (
  id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  platform ENUM('mt4','mt5') NOT NULL,
  installation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  deleted_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  KEY idx_terminal_profiles_user (user_id, deleted_at_utc, updated_at_utc),
  UNIQUE KEY uk_terminal_profile_install (user_id, installation_id, id),
  CONSTRAINT fk_terminal_profiles_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS terminal_account_bindings (
  terminal_profile_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  terminal_instance_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bound_at_utc DATETIME(3) NOT NULL,
  unbound_at_utc DATETIME(3) NULL,
  PRIMARY KEY (terminal_profile_id, trading_account_id, bound_at_utc),
  KEY idx_terminal_bindings_route (trading_account_id, unbound_at_utc, terminal_instance_id),
  CONSTRAINT fk_terminal_bindings_profile FOREIGN KEY (terminal_profile_id) REFERENCES terminal_profiles (id),
  CONSTRAINT fk_terminal_bindings_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bridge_connection_capacity_grants (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  quantity INT UNSIGNED NOT NULL,
  source_type ENUM('purchase','admin','migration') NOT NULL,
  source_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  starts_at_utc DATETIME(3) NOT NULL,
  expires_at_utc DATETIME(3) NULL,
  revoked_at_utc DATETIME(3) NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_bridge_capacity_source (source_type, source_id),
  KEY idx_bridge_capacity_active (user_id, revoked_at_utc, starts_at_utc, expires_at_utc),
  CONSTRAINT fk_bridge_capacity_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS bridge_connection_sessions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  terminal_profile_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  terminal_instance_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  connection_epoch VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  connected_at_utc DATETIME(3) NOT NULL,
  last_seen_at_utc DATETIME(3) NOT NULL,
  disconnected_at_utc DATETIME(3) NULL,
  disconnect_reason VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_bridge_connection_epoch (connection_epoch),
  KEY idx_bridge_sessions_user_online (user_id, disconnected_at_utc, last_seen_at_utc),
  KEY idx_bridge_sessions_route (trading_account_id, disconnected_at_utc, connected_at_utc),
  CONSTRAINT fk_bridge_sessions_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_bridge_sessions_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_bridge_sessions_profile FOREIGN KEY (terminal_profile_id) REFERENCES terminal_profiles (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS observer_channels (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  source_trading_account_id BIGINT UNSIGNED NOT NULL,
  display_name VARCHAR(128) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_by_user_id INT NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_observer_channels_active (active, id),
  CONSTRAINT fk_observer_channel_account FOREIGN KEY (source_trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_observer_channel_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS observer_channel_accesses (
  observer_channel_id BIGINT UNSIGNED NOT NULL,
  user_id INT NOT NULL,
  granted_at_utc DATETIME(3) NOT NULL,
  revoked_at_utc DATETIME(3) NULL,
  PRIMARY KEY (observer_channel_id, user_id),
  KEY idx_observer_access_user (user_id, revoked_at_utc, observer_channel_id),
  CONSTRAINT fk_observer_access_channel FOREIGN KEY (observer_channel_id) REFERENCES observer_channels (id),
  CONSTRAINT fk_observer_access_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS trading_contexts (
  user_id INT NOT NULL,
  mode ENUM('full','observer','blocked') NOT NULL,
  trading_account_id BIGINT UNSIGNED NULL,
  observer_channel_id BIGINT UNSIGNED NULL,
  read_only TINYINT(1) NOT NULL DEFAULT 1,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id),
  KEY idx_trading_context_account (trading_account_id, user_id),
  CONSTRAINT fk_trading_context_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_trading_context_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_trading_context_observer FOREIGN KEY (observer_channel_id) REFERENCES observer_channels (id),
  CONSTRAINT chk_trading_context_target CHECK ((mode='full' AND trading_account_id IS NOT NULL AND observer_channel_id IS NULL) OR (mode='observer' AND trading_account_id IS NULL AND observer_channel_id IS NOT NULL AND read_only=1) OR (mode='blocked' AND trading_account_id IS NULL AND observer_channel_id IS NULL AND read_only=1))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_runtime_snapshots (
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

CREATE TABLE IF NOT EXISTS market_quotes (
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

CREATE TABLE IF NOT EXISTS market_candles (
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

CREATE TABLE IF NOT EXISTS open_position_snapshots (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  ticket VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_json JSON NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (trading_account_id, ticket),
  KEY idx_open_positions_revision (trading_account_id, revision),
  CONSTRAINT fk_open_positions_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS pending_order_snapshots (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  ticket VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_json JSON NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (trading_account_id, ticket),
  KEY idx_pending_orders_revision (trading_account_id, revision),
  CONSTRAINT fk_pending_orders_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS trading_projection_revisions (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  resource_kind VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (trading_account_id, resource_kind, resource_id),
  CONSTRAINT fk_projection_revisions_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Legacy data is migrated by the release runner through deterministic legacy_id_map/checkpoint batches.
-- Never use one unbounded transaction. Read legacy rows by ascending primary key, upsert no more than 500 rows,
-- persist the checkpoint, then reconcile row counts, ownerships, account identities and latest revisions before cutover.
