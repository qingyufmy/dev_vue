-- Candidate only: immutable partial-close continuation registration; no runtime activation.
-- Current upgrades require parent admission and restored-copy rehearsal before execution.
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
