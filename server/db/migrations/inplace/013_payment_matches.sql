-- Payment observations and matching requests. No historical side effects are replayed.
-- Requires payment_orders; pending reference rehearsal and coordinator registration.
CREATE TABLE `payment_transactions` (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  chain VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  transaction_hash VARCHAR(100) CHARACTER SET ascii COLLATE ascii_general_ci NOT NULL,
  asset_contract VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  asset_code VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  recipient_address VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  received_amount DECIMAL(20,8) NOT NULL,
  occurred_at_utc DATETIME(3) NOT NULL,
  first_observed_at_utc DATETIME(3) NOT NULL,
  last_observed_at_utc DATETIME(3) NOT NULL,
  confirmations INT UNSIGNED NOT NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_transaction_hash (transaction_hash),
  UNIQUE KEY uq_payment_transaction_destination (id, chain, asset_contract, recipient_address),
  KEY idx_payment_transaction_observed (last_observed_at_utc, id),
  CONSTRAINT ck_payment_transaction_amount CHECK (received_amount > 0),
  CONSTRAINT ck_payment_transaction_revision CHECK (revision > 0),
  CONSTRAINT ck_payment_transaction_observation CHECK (last_observed_at_utc >= first_observed_at_utc)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE `payment_matches` (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  payment_order_id BIGINT UNSIGNED NOT NULL,
  user_id INT NOT NULL,
  chain VARCHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  asset_contract VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  recipient_address VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  expected_amount DECIMAL(20,8) NOT NULL,
  required_confirmations INT NULL,
  payment_transaction_id BIGINT UNSIGNED NULL,
  status VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  window_start_at_utc DATETIME(3) NOT NULL,
  expires_at_utc DATETIME(3) NOT NULL,
  created_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  origin VARCHAR(20) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  legacy_watch_id INT NULL,
  legacy_confirmations INT NULL,
  legacy_wallet_index INT NULL,
  migration_run_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  source_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  imported_at_utc DATETIME(3) NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payment_match_order (payment_order_id),
  UNIQUE KEY uq_payment_match_transaction (payment_transaction_id),
  UNIQUE KEY uq_payment_match_legacy (legacy_watch_id),
  KEY idx_payment_match_expiry (status, expires_at_utc, id),
  KEY idx_payment_match_scan (chain, status, recipient_address, id),
  CONSTRAINT fk_payment_match_owner FOREIGN KEY (payment_order_id, user_id) REFERENCES payment_orders (id, user_id),
  CONSTRAINT fk_payment_match_transaction FOREIGN KEY (payment_transaction_id, chain, asset_contract, recipient_address)
    REFERENCES payment_transactions (id, chain, asset_contract, recipient_address),
  CONSTRAINT fk_payment_match_migration FOREIGN KEY (migration_run_id) REFERENCES data_migration_runs (id),
  CONSTRAINT ck_payment_match_amount CHECK (expected_amount > 0),
  CONSTRAINT ck_payment_match_revision CHECK (revision > 0),
  CONSTRAINT ck_payment_match_window CHECK (expires_at_utc > window_start_at_utc),
  CONSTRAINT ck_payment_match_confirmations CHECK (required_confirmations IS NULL OR required_confirmations > 0),
  CONSTRAINT ck_payment_match_status CHECK (status IN ('pending', 'confirming', 'confirmed', 'cancelled', 'expired')),
  CONSTRAINT ck_payment_match_claim CHECK (
    (status = 'pending' AND payment_transaction_id IS NULL)
    OR (status IN ('confirming', 'confirmed') AND payment_transaction_id IS NOT NULL AND required_confirmations IS NOT NULL)
    OR status IN ('cancelled', 'expired')
  ),
  CONSTRAINT ck_payment_match_origin CHECK (
    (origin = 'legacy_import' AND legacy_watch_id IS NOT NULL AND legacy_watch_id > 0
      AND migration_run_id IS NOT NULL AND source_sha256 IS NOT NULL AND imported_at_utc IS NOT NULL)
    OR (origin = 'native' AND legacy_watch_id IS NULL AND legacy_confirmations IS NULL AND legacy_wallet_index IS NULL
      AND migration_run_id IS NULL AND source_sha256 IS NULL AND imported_at_utc IS NULL
      AND required_confirmations IS NOT NULL AND created_at_utc IS NOT NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;
