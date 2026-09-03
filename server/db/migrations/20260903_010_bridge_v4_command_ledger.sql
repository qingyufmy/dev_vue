-- Stage 12F: server-side Bridge V4 command ledger and reconciliation evidence.
-- Write-only migration artifact. Application startup must never execute this file.
--
-- The legacy opaque connection_epoch remains intact. Bridge V4 receives a separate numeric
-- fence so an existing e1/e2-style lease is never guessed or destructively converted.

ALTER TABLE bridge_connection_sessions
  DROP INDEX uk_bridge_connection_epoch,
  ADD COLUMN connection_epoch_v4 BIGINT UNSIGNED NULL AFTER connection_epoch,
  ADD UNIQUE KEY uk_bridge_connection_route_epoch (terminal_instance_id, connection_epoch),
  ADD UNIQUE KEY uk_bridge_connection_route_epoch_v4 (terminal_instance_id, connection_epoch_v4),
  ADD CONSTRAINT chk_bridge_connection_epoch_v4_safe
    CHECK (connection_epoch_v4 IS NULL OR connection_epoch_v4 BETWEEN 1 AND 9007199254740991);

-- A succeeded command is not removed from risk capacity until a trusted Bridge
-- projection proves that the resulting position/order has been absorbed.
ALTER TABLE risk_reservations_v4
  MODIFY COLUMN status ENUM('active','committed','absorbed','released','expired') NOT NULL;

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

CREATE TABLE IF NOT EXISTS bridge_command_payloads_v4 (
  bridge_command_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  params_json JSON NOT NULL,
  expected_state_json JSON NULL,
  request_envelope_json JSON NOT NULL,
  payload_bytes INT UNSIGNED NOT NULL,
  PRIMARY KEY (bridge_command_id),
  CONSTRAINT fk_bridge_command_payload_command FOREIGN KEY (bridge_command_id) REFERENCES bridge_commands_v4 (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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

-- No legacy bridge_v3_command_ledger backfill is performed here. A later bounded migration job must
-- preserve the original command identity, route, request/result hashes and any possibly-sent state.
-- Unknown legacy outcomes map to uncertain and may only be reconciled; they are never replayed.
