-- Append after the reviewed risk core structure upgrade. No seeds or backfill.
-- Not part of the frozen 043 eight-step proof; requires its own upgrade evidence.
CREATE TABLE risk_policy_write_receipts (
  user_id INT NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  result_json JSON NOT NULL,
  result_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (user_id, trading_account_id, idempotency_key),
  CONSTRAINT fk_risk_policy_receipt_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT fk_risk_policy_receipt_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
