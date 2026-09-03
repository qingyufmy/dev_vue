-- Stage 12B: scheduled analysis, frozen market source and conditional account fan-out.
-- TARGET: V4 side-by-side database after 20260903_004. Existing V4 analysis rows are preserved.
-- Model calls and market reads stay outside database transactions.

ALTER TABLE market_analyses
  ADD COLUMN opportunity ENUM('none','long_setup','short_setup') NULL AFTER market_bias;

UPDATE market_analyses
SET opportunity = CASE recommendation
  WHEN 'long_candidate' THEN 'long_setup'
  WHEN 'short_candidate' THEN 'short_setup'
  ELSE 'none'
END
WHERE opportunity IS NULL;

ALTER TABLE market_analyses
  MODIFY COLUMN opportunity ENUM('none','long_setup','short_setup') NOT NULL,
  DROP COLUMN recommendation;

ALTER TABLE ai_analysis_runs
  ADD COLUMN market_source_account_id BIGINT UNSIGNED NULL AFTER standard_symbol,
  ADD KEY idx_ai_analysis_source (market_source_account_id, created_at_utc, id),
  ADD CONSTRAINT fk_ai_analysis_source_account FOREIGN KEY (market_source_account_id) REFERENCES trading_accounts (id);

ALTER TABLE ai_model_tasks
  ADD COLUMN lease_owner VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER fencing_token,
  ADD COLUMN lease_expires_at_utc DATETIME(3) NULL AFTER lease_owner,
  ADD COLUMN completed_at_utc DATETIME(3) NULL AFTER updated_at_utc,
  ADD KEY idx_ai_model_tasks_lease (status, lease_expires_at_utc, id);

ALTER TABLE ai_trader_runs
  ADD COLUMN task_mode ENUM('entry','manage','both') NOT NULL AFTER strategy_version_id,
  ADD COLUMN positions_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER task_mode,
  ADD COLUMN pending_orders_revision BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER positions_revision;

CREATE TABLE IF NOT EXISTS macro_research_snapshots (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  owner_scope ENUM('platform','user') NOT NULL,
  owner_user_id INT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  valid_until_utc DATETIME(3) NOT NULL,
  content_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_json JSON NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  KEY idx_macro_snapshot_user (owner_user_id, valid_until_utc, observed_at_utc, id),
  KEY idx_macro_snapshot_platform (owner_scope, valid_until_utc, observed_at_utc, id),
  CONSTRAINT fk_macro_snapshot_owner FOREIGN KEY (owner_user_id) REFERENCES users (id),
  CONSTRAINT chk_macro_snapshot_owner CHECK ((owner_scope='platform' AND owner_user_id IS NULL) OR (owner_scope='user' AND owner_user_id IS NOT NULL)),
  CONSTRAINT chk_macro_snapshot_validity CHECK (valid_until_utc > observed_at_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
