-- Stage 12N: unified user execution command intake and frozen strategy distributions.
-- Structure only. The release migration runner applies this after 009/010; application
-- startup never runs DDL. No legacy row is deleted or rewritten and no command is sent.

ALTER TABLE operations
  ADD COLUMN parent_operation_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER resource_id,
  ADD COLUMN distribution_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER parent_operation_id,
  ADD COLUMN result_summary_json JSON NULL AFTER distribution_id,
  ADD KEY idx_operation_parent (parent_operation_id, status, id),
  ADD KEY idx_operation_distribution (distribution_id, status, id),
  ADD CONSTRAINT fk_operation_parent FOREIGN KEY (parent_operation_id) REFERENCES operations (id);

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

-- AI intents keep their original risk/trade decision links. User commands instead link
-- to the immutable user_execution_commands row; exactly one source family must be set.
ALTER TABLE execution_intents
  DROP FOREIGN KEY fk_execution_intent_risk,
  DROP FOREIGN KEY fk_execution_intent_trade,
  DROP INDEX uk_execution_intent_action,
  MODIFY COLUMN risk_decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  MODIFY COLUMN trade_decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  MODIFY COLUMN risk_decision_revision BIGINT UNSIGNED NULL,
  ADD COLUMN user_command_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER trade_decision_id,
  ADD UNIQUE KEY uk_execution_intent_source_action (source_type, source_id, action_id),
  ADD CONSTRAINT fk_execution_intent_risk FOREIGN KEY (risk_decision_id) REFERENCES risk_decisions_v4 (id),
  ADD CONSTRAINT fk_execution_intent_trade FOREIGN KEY (trade_decision_id) REFERENCES trade_decisions (id),
  ADD CONSTRAINT fk_execution_intent_user_command FOREIGN KEY (user_command_id) REFERENCES user_execution_commands (id),
  ADD CONSTRAINT chk_execution_intent_source_family CHECK (
    (source_type='risk_decision' AND risk_decision_id IS NOT NULL AND trade_decision_id IS NOT NULL AND user_command_id IS NULL) OR
    (source_type<>'risk_decision' AND risk_decision_id IS NULL AND trade_decision_id IS NULL AND user_command_id IS NOT NULL)
  );

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

ALTER TABLE operations
  ADD CONSTRAINT fk_operation_distribution FOREIGN KEY (distribution_id) REFERENCES execution_distributions (id);

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

-- Legacy manual orders and admin distribution rows are intentionally not copied here.
-- A bounded backfill must preserve original identities, target snapshots and possibly-sent
-- states; any ambiguous terminal result maps to uncertain and is reconciled without replay.
