-- V4 strategy, analyst and account-level trader inference core.
-- TARGET: empty V4 side-by-side database only. Never run this file against the legacy database.
-- This migration creates structure only. Legacy backfill is performed by the release migration runner in bounded batches.
-- Model calls, Bridge calls and other external I/O must never run inside these database transactions.

CREATE TABLE IF NOT EXISTS strategies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  kind ENUM('analysis','trader') NOT NULL,
  scope ENUM('platform','user') NOT NULL,
  owner_user_id INT NULL,
  name VARCHAR(191) NOT NULL,
  description VARCHAR(2000) NOT NULL DEFAULT '',
  status ENUM('draft','active','retired') NOT NULL DEFAULT 'draft',
  active_version_id BIGINT UNSIGNED NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  deleted_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_strategies_legacy (legacy_source_table, legacy_id),
  KEY idx_strategies_catalog (kind, status, scope, owner_user_id, deleted_at_utc, id),
  CONSTRAINT fk_strategies_owner FOREIGN KEY (owner_user_id) REFERENCES users (id),
  CONSTRAINT chk_strategies_owner CHECK ((scope='platform' AND owner_user_id IS NULL) OR (scope='user' AND owner_user_id IS NOT NULL))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS strategy_versions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  strategy_id BIGINT UNSIGNED NOT NULL,
  version_number INT UNSIGNED NOT NULL,
  prompt_text LONGTEXT NOT NULL,
  prompt_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_contract_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  output_contract_version VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  config_json JSON NOT NULL,
  created_by_user_id INT NOT NULL,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_strategy_versions_identity (id, strategy_id),
  UNIQUE KEY uk_strategy_versions_number (strategy_id, version_number),
  UNIQUE KEY uk_strategy_versions_legacy (legacy_source_table, legacy_id),
  KEY idx_strategy_versions_created (strategy_id, created_at_utc, id),
  CONSTRAINT fk_strategy_versions_strategy FOREIGN KEY (strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_strategy_versions_creator FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE strategies
  ADD CONSTRAINT fk_strategies_active_version FOREIGN KEY (active_version_id, id) REFERENCES strategy_versions (id, strategy_id);

CREATE TABLE IF NOT EXISTS strategy_subscriptions (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  standard_symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  analysis_strategy_id BIGINT UNSIGNED NOT NULL,
  analysis_strategy_version_id BIGINT UNSIGNED NOT NULL,
  trader_strategy_id BIGINT UNSIGNED NULL,
  trader_strategy_version_id BIGINT UNSIGNED NULL,
  analysis_enabled TINYINT(1) NOT NULL DEFAULT 1,
  trader_enabled TINYINT(1) NOT NULL DEFAULT 0,
  trade_send_enabled TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active','paused','ended') NOT NULL DEFAULT 'active',
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  active_execution_key VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE WHEN status='active' AND trader_enabled=1
        THEN CONCAT(CAST(trading_account_id AS CHAR), ':', standard_symbol)
        ELSE NULL END
    ) STORED,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_strategy_subscription_identity (user_id, trading_account_id, analysis_strategy_id, standard_symbol),
  UNIQUE KEY uk_strategy_subscription_execution_slot (active_execution_key),
  UNIQUE KEY uk_strategy_subscription_legacy (legacy_source_table, legacy_id),
  KEY idx_strategy_subscriptions_analysis (user_id, analysis_strategy_version_id, standard_symbol, status, id),
  KEY idx_strategy_subscriptions_account (trading_account_id, status, id),
  CONSTRAINT fk_strategy_subscriptions_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_strategy_subscriptions_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_strategy_subscriptions_analysis FOREIGN KEY (analysis_strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_strategy_subscriptions_analysis_version FOREIGN KEY (analysis_strategy_version_id, analysis_strategy_id) REFERENCES strategy_versions (id, strategy_id),
  CONSTRAINT fk_strategy_subscriptions_trader FOREIGN KEY (trader_strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_strategy_subscriptions_trader_version FOREIGN KEY (trader_strategy_version_id, trader_strategy_id) REFERENCES strategy_versions (id, strategy_id),
  CONSTRAINT chk_strategy_subscriptions_trader CHECK (
    (trader_enabled=0 AND trade_send_enabled=0) OR
    (trader_enabled=1 AND trader_strategy_id IS NOT NULL AND trader_strategy_version_id IS NOT NULL)
  ),
  CONSTRAINT chk_strategy_subscriptions_send CHECK (trade_send_enabled=0 OR trader_enabled=1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS subscription_schedules (
  subscription_id BIGINT UNSIGNED NOT NULL,
  cadence_seconds INT UNSIGNED NOT NULL DEFAULT 300,
  receive_timezone VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  receive_window_json JSON NOT NULL,
  next_due_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (subscription_id),
  KEY idx_subscription_schedules_due (next_due_at_utc, subscription_id),
  CONSTRAINT fk_subscription_schedules_subscription FOREIGN KEY (subscription_id) REFERENCES strategy_subscriptions (id),
  CONSTRAINT chk_subscription_schedule_cadence CHECK (cadence_seconds >= 60)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inference_snapshots (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  purpose ENUM('analysis','trader') NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NULL,
  strategy_id BIGINT UNSIGNED NOT NULL,
  strategy_version_id BIGINT UNSIGNED NOT NULL,
  standard_symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_bytes BIGINT UNSIGNED NOT NULL,
  captured_at_utc DATETIME(3) NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_inference_snapshot_payload_hash (purpose, user_id, payload_sha256),
  KEY idx_inference_snapshots_user (user_id, purpose, created_at_utc, id),
  KEY idx_inference_snapshots_account (trading_account_id, purpose, created_at_utc, id),
  CONSTRAINT fk_inference_snapshots_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_inference_snapshots_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_inference_snapshots_strategy FOREIGN KEY (strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_inference_snapshots_strategy_version FOREIGN KEY (strategy_version_id, strategy_id) REFERENCES strategy_versions (id, strategy_id),
  CONSTRAINT chk_inference_snapshot_scope CHECK (
    (purpose='analysis' AND trading_account_id IS NULL) OR
    (purpose='trader' AND trading_account_id IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS inference_snapshot_payloads (
  snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  encoding ENUM('json') NOT NULL DEFAULT 'json',
  payload_json JSON NOT NULL,
  PRIMARY KEY (snapshot_id),
  CONSTRAINT fk_inference_snapshot_payload FOREIGN KEY (snapshot_id) REFERENCES inference_snapshots (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_model_tasks (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  purpose ENUM('analysis','trader') NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NULL,
  input_snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model_profile_id BIGINT UNSIGNED NULL,
  status ENUM('queued','running','succeeded','failed','cancelled','expired') NOT NULL,
  deadline_at_utc DATETIME(3) NOT NULL,
  fencing_token BIGINT UNSIGNED NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_ai_model_tasks_worker (purpose, status, created_at_utc, id),
  KEY idx_ai_model_tasks_user (user_id, created_at_utc, id),
  CONSTRAINT fk_ai_model_tasks_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_ai_model_tasks_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_ai_model_tasks_snapshot FOREIGN KEY (input_snapshot_id) REFERENCES inference_snapshots (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_model_attempts (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  attempt_number INT UNSIGNED NOT NULL,
  provider VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  model VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('running','succeeded','failed','timed_out','contract_invalid') NOT NULL,
  started_at_utc DATETIME(3) NOT NULL,
  completed_at_utc DATETIME(3) NULL,
  usage_json JSON NULL,
  error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ai_model_attempt_number (task_id, attempt_number),
  KEY idx_ai_model_attempts_status (status, started_at_utc, id),
  CONSTRAINT fk_ai_model_attempts_task FOREIGN KEY (task_id) REFERENCES ai_model_tasks (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_analysis_runs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  strategy_id BIGINT UNSIGNED NOT NULL,
  strategy_version_id BIGINT UNSIGNED NOT NULL,
  standard_symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trigger_type ENUM('manual','scheduled','event') NOT NULL,
  schedule_slot_utc DATETIME(3) NULL,
  idempotency_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  model_task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status ENUM('queued','running','succeeded','failed','cancelled','expired') NOT NULL,
  error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  completed_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ai_analysis_idempotency (user_id, idempotency_key),
  UNIQUE KEY uk_ai_analysis_schedule (user_id, strategy_version_id, standard_symbol, schedule_slot_utc),
  KEY idx_ai_analysis_history (user_id, created_at_utc, id),
  KEY idx_ai_analysis_worker (status, created_at_utc, id),
  CONSTRAINT fk_ai_analysis_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_ai_analysis_strategy FOREIGN KEY (strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_ai_analysis_strategy_version FOREIGN KEY (strategy_version_id, strategy_id) REFERENCES strategy_versions (id, strategy_id),
  CONSTRAINT fk_ai_analysis_snapshot FOREIGN KEY (input_snapshot_id) REFERENCES inference_snapshots (id),
  CONSTRAINT fk_ai_analysis_model_task FOREIGN KEY (model_task_id) REFERENCES ai_model_tasks (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_manual_analysis_cooldowns (
  user_id INT NOT NULL,
  next_allowed_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_ai_manual_cooldowns_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS market_analyses (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  analysis_run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_scope ENUM('platform','user') NOT NULL DEFAULT 'user',
  owner_user_id INT NULL,
  strategy_id BIGINT UNSIGNED NOT NULL,
  strategy_version_id BIGINT UNSIGNED NOT NULL,
  standard_symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  market_bias ENUM('bullish','bearish','neutral','uncertain') NOT NULL,
  recommendation ENUM('observe','long_candidate','short_candidate','manage_existing') NOT NULL,
  confidence DECIMAL(5,2) NOT NULL,
  summary VARCHAR(2000) NOT NULL,
  input_snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  analyzed_at_utc DATETIME(3) NOT NULL,
  valid_until_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_market_analyses_run (analysis_run_id),
  UNIQUE KEY uk_market_analyses_legacy (legacy_source_table, legacy_id),
  KEY idx_market_analyses_user (owner_user_id, created_at_utc, id),
  KEY idx_market_analyses_strategy_symbol (strategy_id, standard_symbol, created_at_utc, id),
  CONSTRAINT fk_market_analyses_run FOREIGN KEY (analysis_run_id) REFERENCES ai_analysis_runs (id),
  CONSTRAINT fk_market_analyses_owner FOREIGN KEY (owner_user_id) REFERENCES users (id),
  CONSTRAINT fk_market_analyses_strategy FOREIGN KEY (strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_market_analyses_strategy_version FOREIGN KEY (strategy_version_id, strategy_id) REFERENCES strategy_versions (id, strategy_id),
  CONSTRAINT fk_market_analyses_snapshot FOREIGN KEY (input_snapshot_id) REFERENCES inference_snapshots (id),
  CONSTRAINT chk_market_analysis_owner CHECK ((owner_scope='platform' AND owner_user_id IS NULL) OR (owner_scope='user' AND owner_user_id IS NOT NULL)),
  CONSTRAINT chk_market_analysis_confidence CHECK (confidence >= 0 AND confidence <= 100),
  CONSTRAINT chk_market_analysis_validity CHECK (valid_until_utc > analyzed_at_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS market_analysis_payloads (
  market_analysis_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_json JSON NOT NULL,
  payload_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_bytes BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (market_analysis_id),
  CONSTRAINT fk_market_analysis_payload FOREIGN KEY (market_analysis_id) REFERENCES market_analyses (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS ai_trader_runs (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  subscription_id BIGINT UNSIGNED NOT NULL,
  subscription_revision BIGINT UNSIGNED NOT NULL,
  market_analysis_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  strategy_id BIGINT UNSIGNED NOT NULL,
  strategy_version_id BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  input_snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  model_task_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  status ENUM('queued','running','succeeded','failed','cancelled','expired') NOT NULL,
  error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  completed_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_ai_trader_target (market_analysis_id, subscription_id, trading_account_id, subscription_revision, strategy_version_id),
  UNIQUE KEY uk_ai_trader_idempotency (user_id, idempotency_key),
  KEY idx_ai_trader_account (trading_account_id, created_at_utc, id),
  KEY idx_ai_trader_worker (status, created_at_utc, id),
  CONSTRAINT fk_ai_trader_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_ai_trader_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_ai_trader_subscription FOREIGN KEY (subscription_id) REFERENCES strategy_subscriptions (id),
  CONSTRAINT fk_ai_trader_analysis FOREIGN KEY (market_analysis_id) REFERENCES market_analyses (id),
  CONSTRAINT fk_ai_trader_strategy FOREIGN KEY (strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_ai_trader_strategy_version FOREIGN KEY (strategy_version_id, strategy_id) REFERENCES strategy_versions (id, strategy_id),
  CONSTRAINT fk_ai_trader_snapshot FOREIGN KEY (input_snapshot_id) REFERENCES inference_snapshots (id),
  CONSTRAINT fk_ai_trader_model_task FOREIGN KEY (model_task_id) REFERENCES ai_model_tasks (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS trade_decisions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trader_run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  market_analysis_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  strategy_id BIGINT UNSIGNED NOT NULL,
  strategy_version_id BIGINT UNSIGNED NOT NULL,
  action_kind ENUM('hold','market_order','pending_order','modify_position','close_position','modify_order','cancel_order') NOT NULL,
  side ENUM('buy','sell') NULL,
  confidence DECIMAL(5,2) NOT NULL,
  summary VARCHAR(2000) NOT NULL,
  input_snapshot_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('proposed','stale','risk_rejected','accepted') NOT NULL DEFAULT 'proposed',
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_trade_decisions_run (trader_run_id),
  KEY idx_trade_decisions_account (trading_account_id, created_at_utc, id),
  KEY idx_trade_decisions_analysis (market_analysis_id, trading_account_id, id),
  CONSTRAINT fk_trade_decisions_run FOREIGN KEY (trader_run_id) REFERENCES ai_trader_runs (id),
  CONSTRAINT fk_trade_decisions_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_trade_decisions_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_trade_decisions_analysis FOREIGN KEY (market_analysis_id) REFERENCES market_analyses (id),
  CONSTRAINT fk_trade_decisions_strategy FOREIGN KEY (strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_trade_decisions_strategy_version FOREIGN KEY (strategy_version_id, strategy_id) REFERENCES strategy_versions (id, strategy_id),
  CONSTRAINT fk_trade_decisions_snapshot FOREIGN KEY (input_snapshot_id) REFERENCES inference_snapshots (id),
  CONSTRAINT chk_trade_decisions_confidence CHECK (confidence >= 0 AND confidence <= 100)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS trade_decision_payloads (
  trade_decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_json JSON NOT NULL,
  payload_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_bytes BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (trade_decision_id),
  CONSTRAINT fk_trade_decision_payload FOREIGN KEY (trade_decision_id) REFERENCES trade_decisions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS outbox_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  aggregate_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  aggregate_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_json JSON NOT NULL,
  status ENUM('pending','dispatching','dispatched','failed','dead') NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  available_at_utc DATETIME(3) NOT NULL,
  lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at_utc DATETIME(3) NULL,
  created_at_utc DATETIME(3) NOT NULL,
  dispatched_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_outbox_event_id (event_id),
  KEY idx_outbox_dispatch (status, available_at_utc, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Legacy identities are preserved on strategies, versions and market analyses. The release runner must additionally
-- persist per-table checkpoints and legacy-to-V4 ID mappings before any traffic cutover. It must map legacy
-- ai_signals.user_id=0 to owner_scope='platform' and owner_user_id=NULL, never to a fake user row.
