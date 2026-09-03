-- Stage 12E: V4 execution intents and account-level risk reservations.
-- This migration is side-by-side with the legacy order_intents/risk_reservations tables.
-- It creates no Bridge command, performs no terminal/external I/O and does not mutate legacy rows.

CREATE TABLE IF NOT EXISTS operations (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NULL,
  kind VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('accepted','queued','running','succeeded','partially_succeeded','rejected','failed','uncertain','cancelled','expired') NOT NULL,
  source_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_scope VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  resource_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  resource_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  accepted_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  completed_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_operation_idempotency (idempotency_scope,idempotency_key),
  UNIQUE KEY uk_operation_legacy (legacy_source_table,legacy_id),
  KEY idx_operation_user_status (user_id,status,updated_at_utc,id),
  KEY idx_operation_account_status (trading_account_id,status,updated_at_utc,id),
  CONSTRAINT fk_operation_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_operation_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS operation_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  from_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  to_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  from_revision BIGINT UNSIGNED NULL,
  to_revision BIGINT UNSIGNED NOT NULL,
  payload_json JSON NOT NULL,
  occurred_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_operation_event_revision (operation_id,to_revision),
  KEY idx_operation_event_time (occurred_at_utc,id),
  CONSTRAINT fk_operation_event_operation FOREIGN KEY (operation_id) REFERENCES operations (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS execution_intents (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  risk_decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trade_decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  risk_decision_revision BIGINT UNSIGNED NOT NULL,
  account_risk_revision BIGINT UNSIGNED NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  action_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_kind ENUM('market_order','pending_order','modify_position','close_position','modify_order','cancel_order') NOT NULL,
  source_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expected_state_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('preparing','risk_pending','prepared','dispatching','awaiting_result','reconciling','succeeded','rejected','failed','uncertain','cancelled','expired') NOT NULL,
  expires_at_utc DATETIME(3) NOT NULL,
  error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  completed_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_execution_intent_action (risk_decision_id,action_id),
  UNIQUE KEY uk_execution_intent_idempotency (idempotency_key),
  UNIQUE KEY uk_execution_intent_legacy (legacy_source_table,legacy_id),
  KEY idx_execution_intent_operation (operation_id,status,id),
  KEY idx_execution_intent_account_claim (trading_account_id,status,expires_at_utc,id),
  CONSTRAINT fk_execution_intent_operation FOREIGN KEY (operation_id) REFERENCES operations (id),
  CONSTRAINT fk_execution_intent_risk FOREIGN KEY (risk_decision_id) REFERENCES risk_decisions_v4 (id),
  CONSTRAINT fk_execution_intent_trade FOREIGN KEY (trade_decision_id) REFERENCES trade_decisions (id),
  CONSTRAINT fk_execution_intent_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_execution_intent_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS execution_intent_payloads (
  execution_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action_json JSON NOT NULL,
  action_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expected_state_json JSON NOT NULL,
  expected_state_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_bytes BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (execution_intent_id),
  CONSTRAINT fk_execution_intent_payload FOREIGN KEY (execution_intent_id) REFERENCES execution_intents (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS execution_intent_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  execution_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  from_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  to_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  from_revision BIGINT UNSIGNED NULL,
  to_revision BIGINT UNSIGNED NOT NULL,
  payload_json JSON NOT NULL,
  occurred_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_execution_intent_event_revision (execution_intent_id,to_revision),
  KEY idx_execution_intent_event_time (occurred_at_utc,id),
  CONSTRAINT fk_execution_intent_event_intent FOREIGN KEY (execution_intent_id) REFERENCES execution_intents (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS risk_reservations_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  execution_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_currency VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reserved_volume DECIMAL(18,8) NOT NULL,
  reserved_risk_amount DECIMAL(20,8) NOT NULL,
  reserved_risk_percent DECIMAL(12,8) NOT NULL,
  reserved_open_positions INT UNSIGNED NOT NULL,
  reserved_pending_orders INT UNSIGNED NOT NULL,
  reserved_daily_opens INT UNSIGNED NOT NULL,
  status ENUM('active','committed','released','expired') NOT NULL,
  expires_at_utc DATETIME(3) NOT NULL,
  released_at_utc DATETIME(3) NULL,
  release_reason VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_risk_reservation_v4_intent (execution_intent_id),
  UNIQUE KEY uk_risk_reservation_v4_legacy (legacy_source_table,legacy_id),
  KEY idx_risk_reservation_v4_account (trading_account_id,status,expires_at_utc,id),
  CONSTRAINT fk_risk_reservation_v4_intent FOREIGN KEY (execution_intent_id) REFERENCES execution_intents (id),
  CONSTRAINT fk_risk_reservation_v4_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_risk_reservation_v4_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS risk_reservation_events_v4 (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  risk_reservation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  from_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  to_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  from_revision BIGINT UNSIGNED NULL,
  to_revision BIGINT UNSIGNED NOT NULL,
  occurred_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_risk_reservation_event_revision (risk_reservation_id,to_revision),
  CONSTRAINT fk_risk_reservation_event_reservation FOREIGN KEY (risk_reservation_id) REFERENCES risk_reservations_v4 (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE risk_decisions_v4
  ADD COLUMN operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER manual_release_id,
  ADD UNIQUE KEY uk_risk_decision_operation (operation_id),
  ADD CONSTRAINT fk_risk_decision_operation FOREIGN KEY (operation_id) REFERENCES operations (id);

-- Legacy order_intents/risk_reservations backfill is deliberately not executed here. A bounded release job must:
-- 1) preserve legacy IDs/idempotency, 2) map every status explicitly, 3) classify any possibly-sent timeout as
-- uncertain, 4) retain rejected rows and hashes, and 5) compare row counts before a later cutover migration.
