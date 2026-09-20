-- Additive completion traversal receipts. Existing facts and the executed upgrade chain remain unchanged.
CREATE TABLE terminal_history_collection_receipts_v4 (
  id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  trading_account_id BIGINT UNSIGNED NOT NULL,
  user_id INT NOT NULL,
  platform ENUM('mt4','mt5') NOT NULL,
  terminal_instance_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  connection_epoch BIGINT UNSIGNED NOT NULL,
  ownership_revision BIGINT UNSIGNED NULL,
  range_start_utc DATETIME(3) NOT NULL,
  range_end_utc DATETIME(3) NOT NULL,
  evidence_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  evidence_json JSON NOT NULL,
  created_at_utc DATETIME(3) NOT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uk_history_collection_receipt (trading_account_id,evidence_sha256),
  KEY idx_history_collection_window (trading_account_id,terminal_instance_id,range_end_utc),
  CONSTRAINT fk_history_collection_account FOREIGN KEY (trading_account_id) REFERENCES trading_accounts (id),
  CONSTRAINT fk_history_collection_user FOREIGN KEY (user_id) REFERENCES users (id),
  CONSTRAINT chk_history_collection_window CHECK (range_end_utc>range_start_utc),
  CONSTRAINT chk_history_collection_epoch CHECK (connection_epoch>0 AND (ownership_revision IS NULL OR ownership_revision>0)),
  CONSTRAINT chk_history_collection_hash CHECK (REGEXP_LIKE(evidence_sha256,'^[0-9a-f]{64}$','c'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
