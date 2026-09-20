-- Candidate: ordered subscription root, execution foundation and protection workflow DDL.
-- Apply only through the durable upgrade coordinator after verified step 063.

-- Step 1
RENAME TABLE `strategy_subscriptions` TO `strategy_subscriptions_legacy_v3`, `strategy_subscriptions_v4_build` TO `strategy_subscriptions`, `subscription_schedules_v4_build` TO `subscription_schedules`, `subscription_execution_preferences_v4_build` TO `subscription_execution_preferences`;

-- Step 2
ALTER TABLE risk_decisions_v4
  ADD COLUMN manual_release_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER account_risk_revision,
  ADD KEY idx_risk_decision_manual_release (manual_release_id),
  ADD CONSTRAINT fk_risk_decision_manual_release FOREIGN KEY (manual_release_id) REFERENCES risk_manual_releases (id);

-- Step 3
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

-- Step 4
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

-- Step 5
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

-- Step 6
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

-- Step 7
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

-- Step 8
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

-- Step 9
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

-- Step 10
ALTER TABLE risk_decisions_v4
  ADD COLUMN operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER manual_release_id,
  ADD UNIQUE KEY uk_risk_decision_operation (operation_id),
  ADD CONSTRAINT fk_risk_decision_operation FOREIGN KEY (operation_id) REFERENCES operations (id);

-- Step 11
ALTER TABLE risk_reservations_v4
  MODIFY COLUMN status ENUM('active','committed','absorbed','released','expired') NOT NULL;

-- Step 12
CREATE TABLE IF NOT EXISTS bridge_trade_state_snapshots_v4 (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  entity_kind ENUM('position','pending_order') NOT NULL,
  ticket VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  terminal_instance_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  connection_epoch BIGINT UNSIGNED NOT NULL,
  projection_revision BIGINT UNSIGNED NOT NULL,
  state_json JSON NOT NULL,
  state_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (trading_account_id, entity_kind, ticket),
  KEY idx_bridge_trade_state_route (terminal_instance_id, connection_epoch, updated_at_utc),
  CONSTRAINT fk_bridge_trade_state_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT chk_bridge_trade_state_epoch CHECK (connection_epoch BETWEEN 1 AND 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 13
CREATE TABLE IF NOT EXISTS bridge_commands_v4 (
  id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  execution_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_sequence INT UNSIGNED NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  terminal_profile_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  terminal_instance_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  broker_server VARCHAR(128) NOT NULL,
  account_login VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  connection_epoch BIGINT UNSIGNED NOT NULL,
  action ENUM(
    'order.place',
    'position.protection.set',
    'position.close',
    'pending_order.modify',
    'pending_order.cancel'
  ) NOT NULL,
  idempotency_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM(
    'queued','dispatched','accepted','succeeded','rejected','failed','uncertain','reconciling'
  ) NOT NULL,
  issued_at_utc DATETIME(3) NOT NULL,
  deadline_at_utc DATETIME(3) NOT NULL,
  dispatched_at_utc DATETIME(3) NULL,
  accepted_at_utc DATETIME(3) NULL,
  completed_at_utc DATETIME(3) NULL,
  error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  terminal_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  result_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  result_message_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_bridge_command_intent_sequence (execution_intent_id, command_sequence),
  UNIQUE KEY uk_bridge_command_idempotency (idempotency_key),
  UNIQUE KEY uk_bridge_command_result_message (result_message_id),
  KEY idx_bridge_command_dispatch (status, deadline_at_utc, updated_at_utc, id),
  KEY idx_bridge_command_route (terminal_instance_id, connection_epoch, status, id),
  KEY idx_bridge_command_account (trading_account_id, status, updated_at_utc),
  CONSTRAINT fk_bridge_command_intent FOREIGN KEY (execution_intent_id) REFERENCES execution_intents (id),
  CONSTRAINT fk_bridge_command_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_bridge_command_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_bridge_command_profile FOREIGN KEY (terminal_profile_id) REFERENCES terminal_profiles (id),
  CONSTRAINT chk_bridge_command_sequence CHECK (command_sequence BETWEEN 1 AND 65535),
  CONSTRAINT chk_bridge_command_epoch CHECK (connection_epoch BETWEEN 1 AND 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 14
CREATE TABLE IF NOT EXISTS bridge_command_payloads_v4 (
  bridge_command_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  params_json JSON NOT NULL,
  expected_state_json JSON NULL,
  request_envelope_json JSON NOT NULL,
  payload_bytes INT UNSIGNED NOT NULL,
  PRIMARY KEY (bridge_command_id),
  CONSTRAINT fk_bridge_command_payload_command FOREIGN KEY (bridge_command_id) REFERENCES bridge_commands_v4 (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 15
CREATE TABLE IF NOT EXISTS bridge_command_results_v4 (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bridge_command_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  message_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('succeeded','rejected','failed','uncertain') NOT NULL,
  result_json JSON NULL,
  error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  terminal_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  completed_at_utc DATETIME(3) NOT NULL,
  received_at_utc DATETIME(3) NOT NULL,
  conflict TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE KEY uk_bridge_command_result_message_id (message_id),
  KEY idx_bridge_command_results_command (bridge_command_id, received_at_utc, id),
  CONSTRAINT fk_bridge_command_result_command FOREIGN KEY (bridge_command_id) REFERENCES bridge_commands_v4 (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 16
CREATE TABLE IF NOT EXISTS bridge_command_events_v4 (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  bridge_command_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  event_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  from_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  to_status VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  from_revision BIGINT UNSIGNED NULL,
  to_revision BIGINT UNSIGNED NOT NULL,
  evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  occurred_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_bridge_command_event_revision (bridge_command_id, to_revision),
  CONSTRAINT fk_bridge_command_event_command FOREIGN KEY (bridge_command_id) REFERENCES bridge_commands_v4 (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 17
ALTER TABLE operations
  ADD COLUMN parent_operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER resource_id,
  ADD COLUMN distribution_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER parent_operation_id,
  ADD COLUMN result_summary_json JSON NULL AFTER distribution_id,
  ADD KEY idx_operation_parent (parent_operation_id, status, id),
  ADD KEY idx_operation_distribution (distribution_id, status, id),
  ADD CONSTRAINT fk_operation_parent FOREIGN KEY (parent_operation_id) REFERENCES operations (id);

-- Step 18
CREATE TABLE IF NOT EXISTS user_execution_commands (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  command_type ENUM('market_order','pending_order','modify_position','close_position','modify_order','cancel_order') NOT NULL,
  source_type ENUM('user_command','strategy_distribution','distribution_close') NOT NULL,
  source_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  idempotency_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_json JSON NOT NULL,
  action_json JSON NOT NULL,
  expected_state_json JSON NOT NULL,
  risk_evaluation_json JSON NOT NULL,
  risk_status ENUM('approved','rejected') NOT NULL,
  reject_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  platform_policy_version_id BIGINT UNSIGNED NOT NULL,
  account_policy_version_id BIGINT UNSIGNED NULL,
  policy_set_revision BIGINT UNSIGNED NOT NULL,
  policy_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_revision BIGINT UNSIGNED NOT NULL,
  positions_revision BIGINT UNSIGNED NOT NULL,
  pending_orders_revision BIGINT UNSIGNED NOT NULL,
  quote_revision BIGINT UNSIGNED NOT NULL,
  contract_revision BIGINT UNSIGNED NOT NULL,
  risk_revision BIGINT UNSIGNED NOT NULL,
  manual_release_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_user_execution_command_operation (operation_id),
  UNIQUE KEY uk_user_execution_command_idempotency (user_id, trading_account_id, idempotency_key),
  KEY idx_user_execution_command_account (trading_account_id, created_at_utc, id),
  CONSTRAINT fk_user_execution_command_operation FOREIGN KEY (operation_id) REFERENCES operations (id),
  CONSTRAINT fk_user_execution_command_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_user_execution_command_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_user_execution_command_platform_policy FOREIGN KEY (platform_policy_version_id) REFERENCES risk_policy_versions_v4 (id),
  CONSTRAINT fk_user_execution_command_account_policy FOREIGN KEY (account_policy_version_id) REFERENCES risk_policy_versions_v4 (id),
  CONSTRAINT fk_user_execution_command_release FOREIGN KEY (manual_release_id) REFERENCES risk_manual_releases (id),
  CONSTRAINT chk_user_execution_command_risk CHECK (
    (risk_status='approved' AND reject_code IS NULL) OR
    (risk_status='rejected' AND reject_code IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 19
ALTER TABLE execution_intents
  DROP FOREIGN KEY fk_execution_intent_risk,
  DROP FOREIGN KEY fk_execution_intent_trade,
  DROP INDEX uk_execution_intent_action,
  MODIFY COLUMN risk_decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  MODIFY COLUMN trade_decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  MODIFY COLUMN risk_decision_revision BIGINT UNSIGNED NULL,
  ADD COLUMN user_command_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER trade_decision_id,
  ADD UNIQUE KEY uk_execution_intent_source_action (source_type, source_id, action_id),
  ADD CONSTRAINT fk_execution_intent_risk_v4 FOREIGN KEY (risk_decision_id) REFERENCES risk_decisions_v4 (id),
  ADD CONSTRAINT fk_execution_intent_trade_v4 FOREIGN KEY (trade_decision_id) REFERENCES trade_decisions (id),
  ADD CONSTRAINT fk_execution_intent_user_command FOREIGN KEY (user_command_id) REFERENCES user_execution_commands (id),
  ADD CONSTRAINT chk_execution_intent_source_family CHECK (
    (source_type='risk_decision' AND risk_decision_id IS NOT NULL AND trade_decision_id IS NOT NULL AND user_command_id IS NULL) OR
    (source_type<>'risk_decision' AND risk_decision_id IS NULL AND trade_decision_id IS NULL AND user_command_id IS NOT NULL)
  );

-- Step 20
CREATE TABLE IF NOT EXISTS execution_distributions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parent_operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_user_id INT NOT NULL,
  strategy_id BIGINT UNSIGNED NOT NULL,
  strategy_version_id BIGINT UNSIGNED NOT NULL,
  kind ENUM('manual_order','close') NOT NULL,
  source_distribution_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  idempotency_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_json JSON NOT NULL,
  status ENUM('accepted','queued','running','succeeded','partially_succeeded','rejected','failed','uncertain','cancelled','expired') NOT NULL,
  target_count INT UNSIGNED NOT NULL,
  result_summary_json JSON NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  completed_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_execution_distribution_operation (parent_operation_id),
  UNIQUE KEY uk_execution_distribution_idempotency (actor_user_id, idempotency_key),
  KEY idx_execution_distribution_status (status, updated_at_utc, id),
  CONSTRAINT fk_execution_distribution_operation FOREIGN KEY (parent_operation_id) REFERENCES operations (id),
  CONSTRAINT fk_execution_distribution_actor FOREIGN KEY (actor_user_id) REFERENCES users (id),
  CONSTRAINT fk_execution_distribution_strategy FOREIGN KEY (strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_execution_distribution_strategy_version FOREIGN KEY (strategy_version_id, strategy_id) REFERENCES strategy_versions (id, strategy_id),
  CONSTRAINT fk_execution_distribution_source FOREIGN KEY (source_distribution_id) REFERENCES execution_distributions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 21
ALTER TABLE operations
  ADD CONSTRAINT fk_operation_distribution FOREIGN KEY (distribution_id) REFERENCES execution_distributions (id);

-- Step 22
CREATE TABLE IF NOT EXISTS execution_distribution_targets (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  distribution_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  subscription_id BIGINT UNSIGNED NULL,
  subscription_revision BIGINT UNSIGNED NULL,
  source_outcome_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_ticket VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  child_operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  frozen_context_json JSON NOT NULL,
  status ENUM('queued','running','succeeded','rejected','failed','uncertain','cancelled','expired') NOT NULL,
  error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  completed_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_execution_distribution_target_account (distribution_id, trading_account_id, source_outcome_id),
  UNIQUE KEY uk_execution_distribution_child_operation (child_operation_id),
  KEY idx_execution_distribution_target_claim (status, updated_at_utc, id),
  CONSTRAINT fk_execution_distribution_target_distribution FOREIGN KEY (distribution_id) REFERENCES execution_distributions (id),
  CONSTRAINT fk_execution_distribution_target_user FOREIGN KEY (target_user_id) REFERENCES users (id),
  CONSTRAINT fk_execution_distribution_target_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_execution_distribution_target_subscription FOREIGN KEY (subscription_id) REFERENCES strategy_subscriptions (id),
  CONSTRAINT fk_execution_distribution_target_operation FOREIGN KEY (child_operation_id) REFERENCES operations (id),
  CONSTRAINT chk_execution_distribution_target_source CHECK (
    (source_outcome_id IS NULL AND source_ticket IS NULL) OR
    (source_outcome_id IS NOT NULL AND source_ticket IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 23
CREATE TABLE IF NOT EXISTS execution_outcomes (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  execution_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  distribution_target_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  resource_kind ENUM('position','pending_order','deal','none','unknown') NOT NULL,
  ticket VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  result_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('succeeded','rejected','failed','uncertain') NOT NULL,
  result_json JSON NULL,
  confirmed_at_utc DATETIME(3) NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_execution_outcome_intent (execution_intent_id),
  KEY idx_execution_outcome_distribution (distribution_target_id, status, id),
  KEY idx_execution_outcome_ticket (trading_account_id, resource_kind, ticket),
  CONSTRAINT fk_execution_outcome_intent FOREIGN KEY (execution_intent_id) REFERENCES execution_intents (id),
  CONSTRAINT fk_execution_outcome_distribution_target FOREIGN KEY (distribution_target_id) REFERENCES execution_distribution_targets (id),
  CONSTRAINT fk_execution_outcome_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 24
CREATE TABLE partial_close_workflows_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parent_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  parent_command_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  plan_json JSON NOT NULL,
  plan_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('awaiting_close','risk_review_required','protecting','succeeded','stopped','expired') NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  expires_at_utc DATETIME(3) NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_partial_close_parent_intent (parent_intent_id),
  UNIQUE KEY uk_partial_close_parent_command (parent_command_id),
  KEY idx_partial_close_recovery (status,updated_at_utc,id),
  KEY idx_partial_close_account (trading_account_id,status,id),
  CONSTRAINT fk_partial_close_intent FOREIGN KEY (parent_intent_id) REFERENCES execution_intents (id),
  CONSTRAINT fk_partial_close_command FOREIGN KEY (parent_command_id) REFERENCES bridge_commands_v4 (id),
  CONSTRAINT fk_partial_close_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_partial_close_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT chk_partial_close_revision CHECK (revision BETWEEN 1 AND 9007199254740991),
  CONSTRAINT chk_partial_close_expiry CHECK (expires_at_utc > created_at_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 25
CREATE TABLE partial_close_workflow_events_v4 (
  workflow_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  event_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_json JSON NOT NULL,
  payload_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  occurred_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (workflow_id,revision),
  CONSTRAINT fk_partial_close_event_workflow FOREIGN KEY (workflow_id) REFERENCES partial_close_workflows_v4 (id),
  CONSTRAINT chk_partial_close_event_revision CHECK (revision BETWEEN 1 AND 9007199254740991)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 26
ALTER TABLE execution_intents
  DROP CHECK chk_execution_intent_source_family,
  ADD COLUMN position_workflow_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD UNIQUE KEY uk_execution_intent_position_workflow (position_workflow_id),
  ADD UNIQUE KEY uk_execution_intent_workflow_pair (id,position_workflow_id),
  ADD CONSTRAINT fk_execution_intent_position_workflow FOREIGN KEY (position_workflow_id) REFERENCES partial_close_workflows_v4 (id),
  ADD CONSTRAINT chk_execution_intent_source_family CHECK (
    (source_type='risk_decision' AND risk_decision_id IS NOT NULL AND trade_decision_id IS NOT NULL AND user_command_id IS NULL AND position_workflow_id IS NULL) OR
    (source_type NOT IN ('risk_decision','position_workflow') AND risk_decision_id IS NULL AND trade_decision_id IS NULL AND user_command_id IS NOT NULL AND position_workflow_id IS NULL) OR
    (source_type='position_workflow' AND risk_decision_id IS NULL AND trade_decision_id IS NULL AND user_command_id IS NULL
      AND risk_decision_revision IS NULL AND position_workflow_id IS NOT NULL AND source_id=position_workflow_id AND action_kind='modify_position')
  );

-- Step 27
CREATE TABLE position_protection_reviews_v4 (
  workflow_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workflow_revision BIGINT UNSIGNED NOT NULL,
  request_json JSON NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  review_json JSON NOT NULL,
  review_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('approved','rejected') NOT NULL,
  child_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  child_json JSON NULL,
  child_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (workflow_id),
  UNIQUE KEY uk_protection_review_child (child_intent_id),
  CONSTRAINT fk_protection_review_workflow FOREIGN KEY (workflow_id) REFERENCES partial_close_workflows_v4 (id),
  CONSTRAINT fk_protection_review_child FOREIGN KEY (child_intent_id,workflow_id) REFERENCES execution_intents (id,position_workflow_id),
  CONSTRAINT chk_protection_review_revision CHECK (workflow_revision=2),
  CONSTRAINT chk_protection_review_child CHECK (
    (status='approved' AND child_intent_id IS NOT NULL AND child_json IS NOT NULL AND child_sha256 IS NOT NULL) OR
    (status='rejected' AND child_intent_id IS NULL AND child_json IS NULL AND child_sha256 IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 28
ALTER TABLE bridge_commands_v4
  ADD UNIQUE KEY uk_bridge_command_intent_pair (id,execution_intent_id);

-- Step 29
CREATE TABLE position_protection_commands_v4 (
  bridge_command_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  child_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  workflow_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  binding_json JSON NOT NULL,
  binding_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  authority_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (bridge_command_id),
  UNIQUE KEY uk_protection_command_child (child_intent_id),
  UNIQUE KEY uk_protection_command_workflow (workflow_id),
  CONSTRAINT fk_protection_command_child FOREIGN KEY (child_intent_id,workflow_id) REFERENCES execution_intents (id,position_workflow_id),
  CONSTRAINT fk_protection_command_bridge FOREIGN KEY (bridge_command_id,child_intent_id) REFERENCES bridge_commands_v4 (id,execution_intent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 30
CREATE TABLE position_protection_dispatches_v4 (
  bridge_command_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  command_revision INT UNSIGNED NOT NULL,
  review_json JSON NOT NULL,
  review_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  checked_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (bridge_command_id),
  CONSTRAINT ck_protection_dispatch_revision CHECK (command_revision=2),
  CONSTRAINT fk_protection_dispatch_binding FOREIGN KEY (bridge_command_id)
    REFERENCES position_protection_commands_v4 (bridge_command_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 31
CREATE TABLE position_protection_outcomes_v4 (
  workflow_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  child_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  bridge_command_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  evidence_json JSON NOT NULL,
  evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (workflow_id),
  UNIQUE KEY uk_protection_outcome_command (bridge_command_id),
  CONSTRAINT ck_protection_outcome_status CHECK (status IN ('succeeded','stopped')),
  CONSTRAINT fk_protection_outcome_child FOREIGN KEY (child_intent_id,workflow_id) REFERENCES execution_intents (id,position_workflow_id),
  CONSTRAINT fk_protection_outcome_command FOREIGN KEY (bridge_command_id,child_intent_id) REFERENCES bridge_commands_v4 (id,execution_intent_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Step 32
CREATE TABLE position_protection_unissued_expiries_v4 (
  workflow_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  child_intent_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  evidence_json JSON NOT NULL,
  evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (workflow_id),
  UNIQUE KEY uk_protection_unissued_child (child_intent_id),
  CONSTRAINT fk_protection_unissued_child FOREIGN KEY (child_intent_id,workflow_id) REFERENCES execution_intents (id,position_workflow_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
