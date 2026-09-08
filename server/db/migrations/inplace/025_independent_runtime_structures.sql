-- Structure only. No seed control values, tasks, pairing codes or memory are created.
-- Original target declarations retained; same-library revision FK applied after both tables.

CREATE TABLE `ai_manual_analysis_cooldowns` (
  user_id INT NOT NULL,
  next_allowed_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id),
  CONSTRAINT fk_ai_manual_cooldowns_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `outbox_events` (
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

CREATE TABLE `global_risk_controls` (
  id TINYINT UNSIGNED NOT NULL,
  kill_switch TINYINT(1) NOT NULL DEFAULT 0,
  reason VARCHAR(1000) NULL,
  changed_by_user_id INT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  CONSTRAINT chk_global_risk_singleton CHECK (id=1),
  CONSTRAINT fk_global_risk_actor FOREIGN KEY (changed_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `strategy_memory_libraries_v4` (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  strategy_id BIGINT UNSIGNED NOT NULL,
  owner_user_id INT NULL,
  mode ENUM('off','shadow','active') NOT NULL DEFAULT 'shadow',
  status ENUM('active','revalidating','retired') NOT NULL DEFAULT 'active',
  current_revision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  max_context_tokens INT UNSIGNED NOT NULL DEFAULT 800,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_strategy_memory_strategy (strategy_id),
  UNIQUE KEY uk_strategy_memory_legacy (legacy_source_table, legacy_id),
  KEY idx_strategy_memory_owner (owner_user_id, updated_at_utc, id),
  CONSTRAINT fk_strategy_memory_strategy FOREIGN KEY (strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_strategy_memory_owner FOREIGN KEY (owner_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `strategy_memory_library_revisions_v4` (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  library_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  version_number INT UNSIGNED NOT NULL,
  content_text MEDIUMTEXT NOT NULL,
  content_json JSON NULL,
  content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  source_kind ENUM('bootstrap','review_merge','manual_edit','compression','migration','revoke') NOT NULL,
  source_metadata_json JSON NOT NULL,
  created_by_user_id INT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_strategy_memory_revision_identity (id, library_id),
  UNIQUE KEY uk_strategy_memory_revision_number (library_id, version_number),
  CONSTRAINT fk_strategy_memory_revision_library FOREIGN KEY (library_id) REFERENCES strategy_memory_libraries_v4 (id),
  CONSTRAINT fk_strategy_memory_revision_actor FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `strategy_memory_libraries_v4`
  ADD CONSTRAINT fk_strategy_memory_current_revision FOREIGN KEY (current_revision_id, id) REFERENCES strategy_memory_library_revisions_v4 (id, library_id);

CREATE TABLE `strategy_memory_injection_logs_v4` (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT NOT NULL,
  strategy_id BIGINT UNSIGNED NOT NULL,
  library_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  library_revision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  runtime_kind ENUM('analysis','review','memory_compression') NOT NULL,
  runtime_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  injected TINYINT(1) NOT NULL,
  matched_context_json JSON NOT NULL,
  token_count INT UNSIGNED NOT NULL,
  occurred_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_strategy_memory_injection (runtime_kind, runtime_id, library_revision_id),
  KEY idx_strategy_memory_injection_strategy (strategy_id, occurred_at_utc, id),
  CONSTRAINT fk_strategy_memory_injection_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_strategy_memory_injection_strategy FOREIGN KEY (strategy_id) REFERENCES strategies (id),
  CONSTRAINT fk_strategy_memory_injection_library FOREIGN KEY (library_id) REFERENCES strategy_memory_libraries_v4 (id),
  CONSTRAINT fk_strategy_memory_injection_revision FOREIGN KEY (library_revision_id, library_id) REFERENCES strategy_memory_library_revisions_v4 (id, library_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `trade_history_migration_checkpoints_v4` (
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

CREATE TABLE `observer_management_registry` (
  id TINYINT UNSIGNED NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  CONSTRAINT chk_observer_management_registry_singleton CHECK (id=1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `observer_management_operations` (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  actor_user_id INT NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  action VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  target_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json JSON NOT NULL,
  audit_json JSON NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_observer_management_operations_actor_key (actor_user_id,idempotency_key),
  KEY idx_observer_management_operations_created (created_at_utc,id),
  CONSTRAINT fk_observer_management_operations_actor FOREIGN KEY (actor_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE `bridge_v4_pairing_requests` (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  request_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  code_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  profile_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  installation_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  refresh_session_id BIGINT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  expires_at_utc DATETIME(3) NOT NULL,
  consumed_at_utc DATETIME(3) NULL,
  revoked_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_bridge_v4_pair_request (user_id, request_key),
  UNIQUE KEY uk_bridge_v4_pair_code (code_hash),
  UNIQUE KEY uk_bridge_v4_pair_profile (profile_id),
  KEY idx_bridge_v4_pair_user_time (user_id, created_at_utc),
  KEY idx_bridge_v4_pair_expiry (expires_at_utc),
  CONSTRAINT fk_bridge_v4_pair_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_bridge_v4_pair_refresh FOREIGN KEY (refresh_session_id) REFERENCES bridge_refresh_sessions (id),
  CONSTRAINT chk_bridge_v4_pair_consumed CHECK (
    (consumed_at_utc IS NULL AND installation_id IS NULL AND refresh_session_id IS NULL)
    OR (consumed_at_utc IS NOT NULL AND installation_id IS NOT NULL AND refresh_session_id IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
