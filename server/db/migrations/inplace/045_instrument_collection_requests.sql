-- On-demand instrument facts. Append-only: no legacy data changes or automatic activation.
-- MySQL owns request payloads; the transport queue carries request IDs only.
CREATE TABLE instrument_collection_requests_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  symbol VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_bucket BIGINT UNSIGNED NOT NULL,
  status ENUM('pending','running','succeeded','failed') NOT NULL DEFAULT 'pending',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  lease_token CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  lease_expires_at_utc DATETIME(3) NULL,
  result_revision BIGINT UNSIGNED NULL,
  error_code VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  requested_at_utc DATETIME(3) NOT NULL,
  updated_at_utc DATETIME(3) NOT NULL,
  completed_at_utc DATETIME(3) NULL,
  revision BIGINT UNSIGNED NOT NULL DEFAULT 1,
  PRIMARY KEY (id),
  UNIQUE KEY uk_instrument_request_scope (user_id,trading_account_id,symbol,request_bucket),
  KEY idx_instrument_request_recovery (status,lease_expires_at_utc,id),
  CONSTRAINT fk_instrument_request_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_instrument_request_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT chk_instrument_request_lease CHECK (
    (status='running' AND lease_token IS NOT NULL AND lease_expires_at_utc IS NOT NULL)
    OR (status<>'running' AND lease_token IS NULL AND lease_expires_at_utc IS NULL)
  ),
  CONSTRAINT chk_instrument_request_completion CHECK (
    (status IN ('pending','running') AND completed_at_utc IS NULL AND result_revision IS NULL)
    OR (status='succeeded' AND completed_at_utc IS NOT NULL AND result_revision IS NOT NULL AND result_revision>0)
    OR (status='failed' AND completed_at_utc IS NOT NULL AND result_revision IS NULL)
  )
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
