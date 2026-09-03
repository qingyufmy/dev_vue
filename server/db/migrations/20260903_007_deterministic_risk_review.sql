-- Stage 12D: normalized deterministic risk policy, account state and trade-decision review.
-- TARGET: V4 side-by-side database after 20260903_006. Never run against the legacy source database.
-- Existing V4 and legacy rows are preserved. This migration does not create execution intents,
-- reservations, Bridge commands or terminal operations, and it performs no external I/O.

CREATE TABLE IF NOT EXISTS risk_policy_sets (
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

CREATE TABLE IF NOT EXISTS risk_policy_versions (
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
  CONSTRAINT fk_risk_policy_version_set FOREIGN KEY (policy_set_id) REFERENCES risk_policy_sets (id),
  CONSTRAINT fk_risk_policy_version_actor FOREIGN KEY (created_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE risk_policy_sets
  ADD CONSTRAINT fk_risk_policy_active_version
    FOREIGN KEY (active_version_id, id) REFERENCES risk_policy_versions (id, policy_set_id);

CREATE TABLE IF NOT EXISTS risk_policy_change_items (
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
  CONSTRAINT fk_risk_policy_change_set FOREIGN KEY (policy_set_id) REFERENCES risk_policy_sets (id),
  CONSTRAINT fk_risk_policy_change_version FOREIGN KEY (policy_version_id) REFERENCES risk_policy_versions (id),
  CONSTRAINT fk_risk_policy_change_actor FOREIGN KEY (requested_by_user_id) REFERENCES users (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS global_risk_controls (
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

CREATE TABLE IF NOT EXISTS account_risk_states (
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

CREATE TABLE IF NOT EXISTS risk_state_events (
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

CREATE TABLE IF NOT EXISTS risk_decisions (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trade_decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  platform_policy_version_id BIGINT UNSIGNED NOT NULL,
  account_policy_version_id BIGINT UNSIGNED NULL,
  policy_set_revision BIGINT UNSIGNED NOT NULL,
  account_risk_revision BIGINT UNSIGNED NOT NULL,
  decision_status ENUM('approved','rejected') NOT NULL,
  reject_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  policy_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  legacy_source_table VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  legacy_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_risk_decision_trade_decision (trade_decision_id),
  UNIQUE KEY uk_risk_decision_legacy (legacy_source_table, legacy_id),
  KEY idx_risk_decision_account (user_id, trading_account_id, created_at_utc, id),
  KEY idx_risk_decision_status (decision_status, created_at_utc, id),
  CONSTRAINT fk_risk_decision_trade FOREIGN KEY (trade_decision_id) REFERENCES trade_decisions (id),
  CONSTRAINT fk_risk_decision_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_risk_decision_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_risk_decision_platform_policy FOREIGN KEY (platform_policy_version_id) REFERENCES risk_policy_versions (id),
  CONSTRAINT fk_risk_decision_account_policy FOREIGN KEY (account_policy_version_id) REFERENCES risk_policy_versions (id),
  CONSTRAINT chk_risk_decision_reject CHECK (
    (decision_status='approved' AND reject_code IS NULL) OR
    (decision_status='rejected' AND reject_code IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS risk_decision_payloads (
  risk_decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  evaluation_json JSON NOT NULL,
  payload_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_bytes BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (risk_decision_id),
  CONSTRAINT fk_risk_decision_payload FOREIGN KEY (risk_decision_id) REFERENCES risk_decisions (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO global_risk_controls (id,kill_switch,reason,changed_by_user_id,revision,updated_at_utc)
VALUES (1,0,'V4 deterministic risk bootstrap',NULL,1,UTC_TIMESTAMP(3))
ON DUPLICATE KEY UPDATE id=id;

INSERT INTO risk_policy_sets (scope,owner_user_id,trading_account_id,name,status,revision,created_at_utc,updated_at_utc)
SELECT 'platform',NULL,NULL,'Platform risk boundary','active',1,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3)
WHERE NOT EXISTS (SELECT 1 FROM risk_policy_sets WHERE scope='platform' AND status='active');

SET @risk_platform_set_id := (
  SELECT id FROM risk_policy_sets WHERE scope='platform' AND status='active' ORDER BY id LIMIT 1
);
SET @risk_platform_default_json := '{"allowedSymbols":["*"],"requireStopLoss":true,"failClosedOnIncompleteData":true,"maxRiskPerTradePercent":1,"maxDailyLossPercent":3,"maxDrawdownPercent":8,"maxOpenPositions":10,"maxPendingOrders":20,"maxTotalVolume":1,"maxSpreadPoints":120,"maxQuoteAgeSeconds":15,"maxRiskSummaryAgeSeconds":30,"maxDecisionAgeSeconds":300,"maxPriceDeviationPercent":0.1,"minOpenIntervalSeconds":30,"maxDailyOpenCount":20,"consecutiveLossLimit":3,"lossCooldownMinutes":60,"pendingValidMinutes":180,"weekendCloseMinutes":60}';

INSERT INTO risk_policy_versions (policy_set_id,version_number,policy_json,policy_sha256,created_by_user_id,change_reason,created_at_utc)
SELECT @risk_platform_set_id,0,@risk_platform_default_json,SHA2(@risk_platform_default_json,256),NULL,'V4 deterministic risk bootstrap',UTC_TIMESTAMP(3)
WHERE NOT EXISTS (SELECT 1 FROM risk_policy_versions WHERE policy_set_id=@risk_platform_set_id);

UPDATE risk_policy_sets p
INNER JOIN risk_policy_versions v ON v.policy_set_id=p.id AND v.version_number=0
SET p.active_version_id=v.id
WHERE p.id=@risk_platform_set_id AND p.active_version_id IS NULL;

ALTER TABLE trade_decisions
  ADD COLUMN risk_decision_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER stale_reason,
  ADD UNIQUE KEY uk_trade_decision_risk (risk_decision_id),
  ADD CONSTRAINT fk_trade_decision_risk FOREIGN KEY (risk_decision_id) REFERENCES risk_decisions (id);

-- Legacy migration is a bounded release job, never an unbounded startup DDL transaction:
-- risk_policy_sets/versions/change_items retain their legacy IDs through the unique source mapping;
-- risk_account_state is transformed into account_risk_states plus append-only risk_state_events;
-- risk_decisions keep the old intent lineage as migration evidence until Stage 12E maps execution intents;
-- risk_profiles merge into account policy versions without deleting their source rows;
-- risk_rule_rollouts and global_risk_control are reconciled into the platform version/control revision.
-- Backfill checkpoints, row counts, rejected rows and hashes are recorded by the release migration runner.
