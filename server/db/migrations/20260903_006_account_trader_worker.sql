-- Stage 12C: account-level Trader Worker context projections and stale-result audit.
-- TARGET: V4 side-by-side database after 20260903_005. Existing V4 rows are preserved.
-- This migration does not enable execution, create order intents, or contact Bridge.

CREATE TABLE IF NOT EXISTS market_instrument_snapshots (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  payload_json JSON NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (trading_account_id, symbol),
  KEY idx_market_instrument_observed (observed_at_utc),
  CONSTRAINT fk_market_instrument_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS account_risk_summaries (
  trading_account_id BIGINT UNSIGNED NOT NULL,
  policy_version_id BIGINT UNSIGNED NULL,
  payload_json JSON NOT NULL,
  observed_at_utc DATETIME(3) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (trading_account_id),
  KEY idx_account_risk_summary_observed (observed_at_utc),
  CONSTRAINT fk_account_risk_summary_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE ai_trader_runs
  ADD COLUMN analysis_revision BIGINT UNSIGNED NOT NULL DEFAULT 1 AFTER task_mode,
  ADD COLUMN account_revision BIGINT UNSIGNED NULL AFTER analysis_revision,
  ADD COLUMN quote_revision BIGINT UNSIGNED NULL AFTER account_revision,
  ADD COLUMN contract_revision BIGINT UNSIGNED NULL AFTER quote_revision,
  ADD COLUMN risk_revision BIGINT UNSIGNED NULL AFTER contract_revision;

ALTER TABLE trade_decisions
  ADD COLUMN stale_reason VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER status;

ALTER TABLE ai_model_tasks
  ADD KEY idx_ai_model_tasks_account_lease (trading_account_id, purpose, status, lease_expires_at_utc, id);

-- Projection writers are introduced with their owning V4 modules. Legacy rows are copied in bounded,
-- checkpointed batches and reconciled before Trader workers are enabled. Missing contract or risk
-- projections fail closed; they are never guessed from prompt text.
