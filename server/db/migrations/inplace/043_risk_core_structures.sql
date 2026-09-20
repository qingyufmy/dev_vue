-- Risk structure only. Apply through the reviewed append-only coordinator, never directly.
-- No default policy, control seed, legacy backfill, or trading activation.
-- Sources and immutable hashes: scripts/lib/risk-structure-source.mjs.

CREATE TABLE risk_policy_sets_v4 (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope ENUM('platform','account') NOT NULL,
  owner_user_id INT NULL,
  trading_account_id BIGINT UNSIGNED NULL,
  name VARCHAR(191) NOT NULL,
  status ENUM('active','retired') NOT NULL DEFAULT 'active',
  active_version_id BIGINT UNSIGNED NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  active_scope_key VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin
    GENERATED ALWAYS AS (
      CASE WHEN status='active' THEN
        CASE WHEN scope='platform' THEN 'platform'
          ELSE CONCAT('account:', CAST(trading_account_id AS CHAR)) END
      ELSE NULL END
    ) STORED,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_risk_policy_active_scope (active_scope_key),
  UNIQUE KEY uk_risk_policy_legacy (legacy_source_table, legacy_id),
  KEY idx_risk_policy_owner (owner_user_id, trading_account_id, status, id),
  CONSTRAINT fk_risk_policy_owner FOREIGN KEY (owner_user_id) REFERENCES users (id),
  CONSTRAINT fk_risk_policy_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT chk_risk_policy_scope CHECK (
    (scope='platform' AND owner_user_id IS NULL AND trading_account_id IS NULL) OR
    (scope='account' AND owner_user_id IS NOT NULL AND trading_account_id IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE risk_policy_versions_v4 (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  policy_set_id BIGINT UNSIGNED NOT NULL,
  version_number INT UNSIGNED NOT NULL,
  policy_json JSON NOT NULL,
  policy_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_by_user_id INT NULL,
  change_reason VARCHAR(500) NOT NULL,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_risk_policy_version_identity (id, policy_set_id),
  UNIQUE KEY uk_risk_policy_version_number (policy_set_id, version_number),
  UNIQUE KEY uk_risk_policy_version_legacy (legacy_source_table, legacy_id),
  CONSTRAINT fk_risk_policy_version_set FOREIGN KEY (policy_set_id) REFERENCES risk_policy_sets_v4 (id),
  CONSTRAINT fk_risk_policy_version_actor FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE risk_policy_sets_v4
  ADD CONSTRAINT fk_risk_policy_active_version
    FOREIGN KEY (active_version_id, id) REFERENCES risk_policy_versions_v4 (id, policy_set_id);

CREATE TABLE risk_policy_change_items_v4 (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  policy_set_id BIGINT UNSIGNED NOT NULL,
  policy_version_id BIGINT UNSIGNED NOT NULL,
  field_code VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  old_value_json JSON NULL,
  new_value_json JSON NULL,
  change_class ENUM('tighten','relax_within_platform','toggle','inherit') NOT NULL,
  requested_by_user_id INT NOT NULL,
  reason VARCHAR(500) NOT NULL,
  changed_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_risk_policy_changes (policy_set_id, changed_at_utc, id),
  CONSTRAINT fk_risk_policy_change_set FOREIGN KEY (policy_set_id) REFERENCES risk_policy_sets_v4 (id),
  CONSTRAINT fk_risk_policy_change_version FOREIGN KEY (policy_version_id) REFERENCES risk_policy_versions_v4 (id),
  CONSTRAINT fk_risk_policy_change_actor FOREIGN KEY (requested_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE account_risk_states (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  user_id INT NOT NULL,
  business_date DATE NULL,
  equity DECIMAL(24,8) NOT NULL,
  free_margin DECIMAL(24,8) NOT NULL,
  daily_loss_percent DECIMAL(12,6) NOT NULL DEFAULT 0,
  drawdown_percent DECIMAL(12,6) NOT NULL DEFAULT 0,
  open_positions INT UNSIGNED NOT NULL DEFAULT 0,
  pending_orders INT UNSIGNED NOT NULL DEFAULT 0,
  total_volume DECIMAL(24,8) NOT NULL DEFAULT 0,
  daily_open_count INT UNSIGNED NOT NULL DEFAULT 0,
  consecutive_losses INT UNSIGNED NOT NULL DEFAULT 0,
  terminal_timezone_offset_minutes SMALLINT NULL,
  clock_status ENUM('calibrated','observer_bootstrap','stale','unavailable') NOT NULL,
  last_successful_open_at_utc DATETIME(3) NULL,
  cooldown_until_utc DATETIME(3) NULL,
  data_complete TINYINT(1) NOT NULL DEFAULT 0,
  incomplete_reasons_json JSON NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (trading_account_id),
  KEY idx_account_risk_state_user (user_id, observed_at_utc, trading_account_id),
  CONSTRAINT fk_account_risk_state_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_account_risk_state_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE risk_state_events (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  user_id INT NOT NULL,
  event_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  from_revision BIGINT UNSIGNED NULL,
  to_revision BIGINT UNSIGNED NOT NULL,
  payload_json JSON NOT NULL,
  occurred_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_risk_state_event_revision (trading_account_id, to_revision),
  KEY idx_risk_state_events_user (user_id, occurred_at_utc, id),
  CONSTRAINT fk_risk_state_event_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_risk_state_event_user FOREIGN KEY (user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE account_risk_summaries (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  policy_version_id BIGINT UNSIGNED NULL,
  payload_json JSON NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (trading_account_id),
  KEY idx_account_risk_summary_observed (observed_at_utc),
  CONSTRAINT fk_account_risk_summary_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE risk_manual_releases (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  platform_policy_version_id BIGINT UNSIGNED NOT NULL,
  account_policy_version_id BIGINT UNSIGNED NULL,
  policy_set_revision BIGINT UNSIGNED NOT NULL,
  risk_state_revision BIGINT UNSIGNED NOT NULL,
  released_rules_json JSON NOT NULL,
  baseline_json JSON NOT NULL,
  breach_fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  reason VARCHAR(500) NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  status ENUM('active','superseded','expired','revoked') NOT NULL DEFAULT 'active',
  expires_at_utc DATETIME(3) NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  invalidated_at_utc DATETIME(3) NULL,
  invalidation_reason VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_risk_manual_release_request (user_id, trading_account_id, idempotency_key),
  UNIQUE KEY uk_risk_manual_release_episode (trading_account_id, breach_fingerprint),
  UNIQUE KEY uk_risk_manual_release_legacy (legacy_source_table, legacy_id),
  KEY idx_risk_manual_release_active (trading_account_id, status, expires_at_utc, created_at_utc),
  CONSTRAINT fk_risk_manual_release_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_risk_manual_release_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_risk_manual_release_platform_policy FOREIGN KEY (platform_policy_version_id) REFERENCES risk_policy_versions_v4 (id),
  CONSTRAINT fk_risk_manual_release_account_policy FOREIGN KEY (account_policy_version_id) REFERENCES risk_policy_versions_v4 (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
