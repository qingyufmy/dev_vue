-- Stage 12S: authoritative terminal trade history and user-facing trade records.
-- Structure only. Application startup never runs DDL. Legacy history remains
-- untouched until a separately authorised, checkpointed and reconciled backfill.

CREATE TABLE IF NOT EXISTS trade_history_sync_states_v4 (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  status ENUM('empty','syncing','ready','stale','failed') NOT NULL DEFAULT 'empty',
  history_revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  fresh_through_utc DATETIME(3) NULL,
  last_success_at_utc DATETIME(3) NULL,
  last_error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (trading_account_id),
  KEY idx_trade_history_sync_status (status, updated_at_utc, trading_account_id),
  CONSTRAINT fk_trade_history_sync_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS terminal_history_orders_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  platform ENUM('mt4','mt5') NOT NULL,
  order_ticket VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  position_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  side ENUM('buy','sell','none','unknown') NOT NULL,
  order_kind VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  order_state VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  volume_initial DECIMAL(24,8) NULL,
  volume_remaining DECIMAL(24,8) NULL,
  price_open DECIMAL(24,8) NULL,
  stop_loss DECIMAL(24,8) NULL,
  take_profit DECIMAL(24,8) NULL,
  magic BIGINT NULL,
  terminal_reason VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  terminal_comment VARCHAR(512) NULL,
  setup_at_utc DATETIME(3) NULL,
  done_at_utc DATETIME(3) NULL,
  terminal_timezone_offset_minutes SMALLINT NOT NULL,
  evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  evidence_json JSON NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_terminal_history_order (trading_account_id, order_ticket),
  KEY idx_terminal_history_order_position (trading_account_id, position_id, done_at_utc, id),
  KEY idx_terminal_history_order_time (trading_account_id, done_at_utc DESC, id),
  CONSTRAINT fk_terminal_history_order_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS terminal_history_deals_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  platform ENUM('mt4','mt5') NOT NULL,
  deal_ticket VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  order_ticket VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  position_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  deal_kind ENUM('trade','balance','credit','fee','correction','other','unknown') NOT NULL,
  entry_kind ENUM('in','out','inout','out_by','none','unknown') NOT NULL,
  side ENUM('buy','sell','none','unknown') NOT NULL,
  volume DECIMAL(24,8) NULL,
  price DECIMAL(24,8) NULL,
  gross_profit DECIMAL(24,8) NOT NULL DEFAULT 0,
  commission DECIMAL(24,8) NOT NULL DEFAULT 0,
  swap_amount DECIMAL(24,8) NOT NULL DEFAULT 0,
  fee_amount DECIMAL(24,8) NOT NULL DEFAULT 0,
  magic BIGINT NULL,
  terminal_reason VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  terminal_comment VARCHAR(512) NULL,
  occurred_at_utc DATETIME(3) NOT NULL,
  terminal_timezone_offset_minutes SMALLINT NOT NULL,
  evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  evidence_json JSON NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_terminal_history_deal (trading_account_id, deal_ticket),
  KEY idx_terminal_history_deal_position (trading_account_id, position_id, occurred_at_utc, id),
  KEY idx_terminal_history_deal_time (trading_account_id, occurred_at_utc DESC, id),
  KEY idx_terminal_history_deal_order (trading_account_id, order_ticket, id),
  CONSTRAINT fk_terminal_history_deal_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_trade_records_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  stable_trade_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  platform ENUM('mt4','mt5') NOT NULL,
  primary_ticket VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  position_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  side ENUM('buy','sell') NOT NULL,
  status ENUM('open','closed','partial','unknown') NOT NULL,
  source_classification ENUM('system','manual','other_ea','mixed','unknown') NOT NULL,
  attribution_status ENUM('exact','partial','conflicted','unresolved') NOT NULL,
  evidence_status ENUM('complete','partial','conflicted') NOT NULL,
  volume_opened DECIMAL(24,8) NOT NULL,
  volume_closed DECIMAL(24,8) NOT NULL,
  entry_price DECIMAL(24,8) NOT NULL,
  exit_price DECIMAL(24,8) NULL,
  stop_loss DECIMAL(24,8) NULL,
  take_profit DECIMAL(24,8) NULL,
  gross_profit DECIMAL(24,8) NOT NULL DEFAULT 0,
  commission DECIMAL(24,8) NOT NULL DEFAULT 0,
  swap_amount DECIMAL(24,8) NOT NULL DEFAULT 0,
  fee_amount DECIMAL(24,8) NOT NULL DEFAULT 0,
  net_profit DECIMAL(24,8) NOT NULL DEFAULT 0,
  opened_at_utc DATETIME(3) NOT NULL,
  closed_at_utc DATETIME(3) NULL,
  close_business_date DATE NULL,
  terminal_timezone_offset_minutes SMALLINT NOT NULL,
  evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_account_trade_stable (trading_account_id, stable_trade_key),
  UNIQUE KEY uk_account_trade_legacy (legacy_source_table, legacy_id),
  KEY idx_account_trade_list (user_id, trading_account_id, closed_at_utc DESC, id),
  KEY idx_account_trade_business_date (user_id, trading_account_id, close_business_date, closed_at_utc DESC, id),
  KEY idx_account_trade_symbol (user_id, trading_account_id, symbol, closed_at_utc DESC, id),
  KEY idx_account_trade_source (user_id, trading_account_id, source_classification, closed_at_utc DESC, id),
  KEY idx_account_trade_pnl (user_id, trading_account_id, net_profit, closed_at_utc DESC, id),
  CONSTRAINT fk_account_trade_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_account_trade_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT chk_account_trade_close CHECK (closed_at_utc IS NULL OR closed_at_utc >= opened_at_utc),
  CONSTRAINT chk_account_trade_volume CHECK (volume_opened > 0 AND volume_closed >= 0 AND volume_closed <= volume_opened)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_trade_record_deals_v4 (
  trade_record_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  terminal_deal_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  sequence_number INT UNSIGNED NOT NULL,
  role ENUM('entry','exit','fee','adjustment','unknown') NOT NULL,
  PRIMARY KEY (trade_record_id, terminal_deal_id),
  UNIQUE KEY uk_account_trade_deal_sequence (trade_record_id, sequence_number),
  CONSTRAINT fk_account_trade_deal_record FOREIGN KEY (trade_record_id) REFERENCES account_trade_records_v4 (id),
  CONSTRAINT fk_account_trade_deal_terminal FOREIGN KEY (terminal_deal_id) REFERENCES terminal_history_deals_v4 (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_trade_attributions_v4 (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  trade_record_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_kind ENUM('market_analysis','trade_decision','risk_decision','execution_intent','execution_outcome','bridge_command','review_case') NOT NULL,
  source_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  relation_kind ENUM('opened','modified','closed','cancelled','reviewed','related') NOT NULL,
  proof_kind ENUM('terminal_ticket','terminal_order','terminal_deal','distribution_target','legacy_mapping') NOT NULL,
  proof_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  metadata_json JSON NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_account_trade_attribution (trade_record_id, source_kind, source_id, relation_kind),
  KEY idx_account_trade_attribution_source (source_kind, source_id, trade_record_id),
  CONSTRAINT fk_account_trade_attribution_record FOREIGN KEY (trade_record_id) REFERENCES account_trade_records_v4 (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_trade_daily_summaries_v4 (
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  business_date DATE NOT NULL,
  terminal_timezone_offset_minutes SMALLINT NOT NULL,
  trade_count INT UNSIGNED NOT NULL,
  winning_count INT UNSIGNED NOT NULL,
  losing_count INT UNSIGNED NOT NULL,
  gross_profit DECIMAL(24,8) NOT NULL,
  commission DECIMAL(24,8) NOT NULL,
  swap_amount DECIMAL(24,8) NOT NULL,
  fee_amount DECIMAL(24,8) NOT NULL,
  net_profit DECIMAL(24,8) NOT NULL,
  history_revision BIGINT UNSIGNED NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id, trading_account_id, business_date),
  KEY idx_account_trade_daily_account (trading_account_id, business_date),
  CONSTRAINT fk_account_trade_daily_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_account_trade_daily_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS trade_history_migration_checkpoints_v4 (
  source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_partition VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  last_source_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  migrated_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  reconciled_count BIGINT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('pending','running','reconciling','complete','failed') NOT NULL DEFAULT 'pending',
  last_error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (source_table, source_partition)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Release migration mapping (never performed by application startup):
-- 1. bridge_v3_deals/order-history and signal_outcomes/deals are read in bounded
--    keyset batches into immutable terminal facts and account trade records.
-- 2. Existing timestamps, terminal offsets, tickets, raw payload hashes and legacy
--    identities are preserved. Unknown or conflicting attribution remains explicit.
-- 3. Per-user/account counts, fee sums and source classifications are reconciled
--    before any read cutover. Source tables remain until a later authorised cleanup.
-- 4. Writers lock one account sync-state row first, then terminal facts in ascending
--    ticket order, trade records by stable key, daily summaries by date, and outbox
--    rows last. This fixed order is required for bounded retries without deadlocks.
